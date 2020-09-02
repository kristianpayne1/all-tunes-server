
var express = require('express'); // Express web server framework
var request = require('request'); // "Request" library
var cors = require('cors');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
var crypto = require('crypto');

var SpotifyWebApi = require('spotify-web-api-node');

// SPOTIFY WEB API
var PORT = process.env.PORT || 8888;

var client_id = '4553b87393ad47fcb7e22bda6e2c8b4d';
var client_secret = '9705be4d156346139ab83e4c8fd0c9ae';
var redirect_uri = 'https://all-tunes-server.herokuapp.com/callback';

/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
var generateRandomString = function (length) {
    var text = '';
    var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (var i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

var stateKey = 'spotify_auth_state';

var app = express();
var expressWs = require('express-ws')(app);

app.use(express.static(__dirname + '/public'))
    .use(cors())
    .use(cookieParser());

app.get('/login', function (req, res) {

    var state = generateRandomString(16);
    res.cookie(stateKey, state);

    // your application requests authorization
    var scope = 'user-top-read user-read-recently-played user-library-read user-modify-playback-state';
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: client_id,
            scope: scope,
            redirect_uri: redirect_uri,
            state: state
        }));
});

app.get('/callback', function (req, res) {

    // your application requests refresh and access tokens
    // after checking the state parameter

    var code = req.query.code || null;
    var state = req.query.state || null;
    var storedState = req.cookies ? req.cookies[stateKey] : null;

    if (state === null || state !== storedState) {
        res.redirect('/#' +
            querystring.stringify({
                error: 'state_mismatch'
            }));
    } else {
        res.clearCookie(stateKey);
        var authOptions = {
            url: 'https://accounts.spotify.com/api/token',
            form: {
                code: code,
                redirect_uri: redirect_uri,
                grant_type: 'authorization_code'
            },
            headers: {
                'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))
            },
            json: true
        };

        request.post(authOptions, function (error, response, body) {
            if (!error && response.statusCode === 200) {

                var access_token = body.access_token,
                    refresh_token = body.refresh_token;

                var options = {
                    url: 'https://api.spotify.com/v1/me',
                    headers: { 'Authorization': 'Bearer ' + access_token },
                    json: true
                };

                // use the access token to access the Spotify Web API
                request.get(options, function (error, response, body) {
                    console.log(body);
                });

                // we can also pass the token to the browser to make requests from there
                res.redirect('https://kristianpayne1.github.io/all-tunes-client/#/home/$' +
                    querystring.stringify({
                        access_token: access_token,
                        refresh_token: refresh_token
                    }));
            } else {
                res.redirect('/#' +
                    querystring.stringify({
                        error: 'invalid_token'
                    }));
            }
        });
    }
});

app.get('/refresh_token', function (req, res) {

    // requesting access token from refresh token
    var refresh_token = req.query.refresh_token;
    var authOptions = {
        url: 'https://accounts.spotify.com/api/token',
        headers: { 'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64')) },
        form: {
            grant_type: 'refresh_token',
            refresh_token: refresh_token
        },
        json: true
    };

    request.post(authOptions, function (error, response, body) {
        if (!error && response.statusCode === 200) {
            var access_token = body.access_token;
            res.send({
                'access_token': access_token
            });
        }
    });
});

// ------------------------------------------------------------
// WEBSOCKET 

// maps rooms to list of clients
let parties = new Map();
// maps room to host
let partyHost = new Map();

app.ws('/', function (ws, req) {
    ws.ip = req.socket.remoteAddress;
    ws.inParty = false;
    ws.partyCode = '';
    ws.spotifyWebApi = new SpotifyWebApi();
    ws.access_token = '';
    ws.topArtists = [];

    // ask client for the spotify access_token
    let response = {
        messageType: 'SEND_ACCESS_TOKEN'
    };
    ws.send(JSON.stringify(response));

    // receiving a message
    ws.on('message', (message) => {
        var data = JSON.parse(message);
        switch (data.messageType) {
            case 'ACCESS_TOKEN': {
                if (data.access_token) {
                    ws.spotifyWebApi.setAccessToken(data.access_token);
                    ws.access_token = data.access_token;
                }
            }
                break;
            case 'CREATE_PARTY': {
                // create random 6 char party code
                ws.partyCode = crypto.randomBytes(20).toString('hex').substring(0, 6).toUpperCase();

                console.log("Party created with party code: " + ws.partyCode);

                // create party 
                parties.set(ws.partyCode, [ws]);
                partyHost.set(ws.partyCode, ws);

                // respond to host with party code
                const response = {
                    messageType: 'CREATE_PARTY_SUCCESS',
                    partyCode: ws.partyCode
                };
                ws.send(JSON.stringify(response));

                // get client's top users
                getTopArtists(ws);
            }
                break;
            case 'JOIN_PARTY_REQUEST': {
                if (parties.has(data.partyCode)) {
                    if (isClientInParty(data.partyCode, ws.ip)) {
                        ws.partyCode = data.partyCode;

                        console.log("Client: " + ws.ip + " joined party: " + ws.partyCode);

                        // add client to party
                        ws.inParty = true;
                        let clients = parties.get(ws.partyCode);
                        clients.push(ws);
                        parties.set(ws.partyCode, clients);
                        const response = {
                            messageType: 'JOINED_PARTY',
                            partyCode: ws.partyCode,
                        };
                        ws.send(JSON.stringify(response));

                        // get client's top users
                        getTopArtists(ws);
                    } else {
                        const response = {
                            messageType: 'JOIN_PARTY_ERROR',
                            error: 'Client already in party'
                        }
                        ws.send(JSON.stringify(response));
                    }
                } else {
                    // tried joining unknown party
                    const response = {
                        messageType: 'JOIN_PARTY_ERROR',
                        error: 'No party found'
                    };
                    ws.send(JSON.stringify(response));
                }
            }
                break;
            case 'QUEUE_SONG' : {
                console.log('Queue song: '+data.uri);

                var queueOptions = {
                    url: 'https://api.spotify.com/v1/me/player/queue',
                    qs: {
                        uri: data.uri
                    },
                    headers: {
                        'Authorization': 'Bearer ' + ws.access_token
                    },
                    json: true
                };

                request.post(queueOptions, function (error, response, body) {
                    if (!error && response.statusCode === 204) {
                        console.log('Song queued');
                    }else{
                        console.log('Failed to queue song. Error code: ' + response.statusCode);
                    }
                });
            }
            break;
            case 'DISCONNECTED': {
                leaveParty(ws);
            }
                break;
        }
    });
});

function updateParty(partyCode) {
    //TODO: OPTIMISE THIS!!

    let clients = parties.get(partyCode);
    let host = partyHost.get(partyCode);

    let topGenres = getTopGenres(clients);
    let genreArtistMap = getGenreTopArtists(clients, topGenres);
    loadRecommendedSongs(host, genreArtistMap, topGenres);
}

function getTopGenres(clients) {
    let genres = new Map();
    clients.forEach((client) => {
        client.topArtists.forEach((artist) => {
            artist.genres.forEach((genre) => {
                if (genres.has(genre)) {
                    genres.set(genre, genres.get(genre) + 1);
                } else {
                    genres.set(genre, 1);
                }
            })
        });
    });

    let topGenres = [];
    for (let i = 0; i < 5; i++) {
        let currentTopGenrePoint = 0;
        let currentTopGenre = '';
        genres.forEach((value, key) => {
            if (value > currentTopGenrePoint) {
                currentTopGenrePoint = value;
                currentTopGenre = key;
            }
        });
        topGenres.push(currentTopGenre);
        genres.delete(currentTopGenre);
    }

    return topGenres;
}

function getGenreTopArtists(clients, genres) {
    //TODO : This algorithm will need tweaking


    let genreArtistMap = new Map();

    // for each genre
    genres.forEach((genre) => {
        // console.log('\n' + genre);
        // get most in common artist
        let artistMap = new Map();
        // for each client
        clients.forEach((client) => {
            // for each clients top artist
            client.topArtists.forEach((artist) => {
                // if artist falls under genre
                if (artist.genres.includes(genre)) {
                    if (artistMap.has(artist)) {
                        artistMap.set(artist, artistMap.get(artist) + 1);
                    } else {
                        artistMap.set(artist, 1);
                    }
                }
            });
        });

        let topGenreArtists = [];
        for (let i = 0; i < 4; i++) {
            let currentTopArtist = '';
            let currentTopArtistPoint = 0;
            artistMap.forEach((value, key) => {
                if (value > currentTopArtistPoint) {
                    currentTopArtistPoint = value;
                    currentTopArtist = key;
                } else if (value === currentTopArtistPoint) {
                    if (currentTopArtist.popularity < key.popularity) {
                        currentTopArtistPoint = value;
                        currentTopArtist = key;
                    }
                }
            });
            //console.log(currentTopArtist.name + ' = ' + currentTopArtistPoint)
            topGenreArtists.push(currentTopArtist);
            artistMap.delete(currentTopArtist);
        }

        genreArtistMap.set(genre, topGenreArtists);
    });
    return genreArtistMap;
}

function getTopArtists(client) {
    client.spotifyWebApi.getMyTopArtists({ time_range: 'medium_term', limit: 50 })
        .then(
            function (data) {
                let topArtists = [];
                data.body.items.forEach(artist => {
                    topArtists.push(artist);
                });
                client.topArtists = topArtists;
                updateParty(client.partyCode)
            },
            function (err) {
                console.error(err);
            }
        );
}

function loadRecommendedSongs(host, genreArtistMap, topGenres) {
    let songArray = [];

    genreArtistMap.forEach((value, key) => {
        let seed_artists = '';
        value.forEach((artist) => {
            seed_artists += artist.id + ','
        });

        songArray.push(getRecommendedSongs(key, seed_artists, host.spotifyWebApi));

    });
    Promise.all(songArray).then((songs) => {
        let genreSong = [];
        for (let i = 0; i < topGenres.length; i++) {
            genreSong.push({genre: topGenres[i], songs : songs[i]});
        }
        sendUpdatedRecommended(genreSong, host);
    })
}

function getRecommendedSongs(genre, seed_artists, spotifyWebApi) {
    // TODO: This needs tweaking too
    return new Promise((resolve, reject) => {
        spotifyWebApi.getRecommendations({ seed_genre: genre.id, seed_artists: seed_artists, min_danceability: 0.75, min_energy: 0.75, min_popularity: 60, min_tempo: 80 })
            .then(
                function (response) {
                    let recommendedSongs = [];
                    response.body.tracks.forEach((song) => {
                        recommendedSongs.push(song);
                    })
                    let sortedSongs = sortRecommendedSongs(recommendedSongs);
                    resolve(sortedSongs);
                },
                function (err) {
                    console.error(err);
                })
    })
}

function sortRecommendedSongs(songs) {
    let n = songs.length;
    for (let i = 1; i < n; ++i) {
        let key = songs[i];
        let j = i - 1;

        while (j >= 0 && songs[j].popularity < key.popularity) {
            songs[j + 1] = songs[j];
            j = j - 1;
        }
        songs[j + 1] = key;
    }
    return songs;
}

function sendUpdatedRecommended(genreSong, host) {
    const message = {
        messageType: 'UPDATE_RECOMMENDED',
        data: genreSong,
    };
    host.send(JSON.stringify(message));
}

function isClientInParty(party, ip) {
    const clients = parties.get(party);
    if (clients === undefined) {
        return false;
    } else {
        return clients.find((item) => item.ip === ip) ? true : false;
    }
};

function leaveParty(ws) {
    if (ws.inParty === true) {
        // Remove the player from the party
        const clients = parties.get(ws.party);
        clients.splice(clients.indexOf(ws.ip), 1);
        parties.set(ws.party, clients);
    }
};

console.log('Listening on ' + PORT);
app.listen(PORT);
