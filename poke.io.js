'use strict';

const request           = require('request');
const geocoder          = require('geocoder');
const events            = require('events');
const ProtoBuf          = require('protobufjs');
const GoogleOAuth       = require('gpsoauthnode');
const Long              = require('long');
const ByteBuffer        = require('bytebuffer');
const Promise           = require('bluebird');
const _                 = require('lodash');

const s2                = require('s2geometry-node');
const Logins            = require('./logins');
const fs                = require('fs');
const pokemonlist       = JSON.parse(fs.readFileSync(__dirname + '/pokemons.json', 'utf8'));

let builder = ProtoBuf.loadProtoFile('pokemon.proto');

if (builder === null) {
    builder = ProtoBuf.loadProtoFile(__dirname + '/pokemon.proto');
}

const pokemonProto      = builder.build();
const EventEmitter      = events.EventEmitter;
const { RequestEnvelop , ResponseEnvelop } = pokemonProto;

const api_url = 'https://pgorelease.nianticlabs.com/plfe/rpc';

function GetCoords(self) {
    let { latitude , longitude }    = self.playerInfo;
    return [ latitude , longitude ];
}


function getNeighbors(lat, lng) {
    var origin          = new s2.S2CellId(new s2.S2LatLng(lat, lng)).parent(15),
        walk            = [origin.id()];

    // 10 before and 10 after

    var next = origin.next(),
        prev = origin.prev();

    for (var i = 0; i < 10; i++) {

        // in range(10):

        walk.push(prev.id());
        walk.push(next.id());

        next = next.next();
        prev = prev.prev();
    }

    return walk;
}

function Pokeio() {
    var self            = this;

    self.events         = new EventEmitter();
    self.j              = request.jar();
    self.request        = request.defaults({jar: self.j});
    self.google         = new GoogleOAuth();

    self.playerInfo     = {
        accessToken         : '',
        debug               : true,
        latitude            : 0,
        longitude           : 0,
        altitude            : 0,
        locationName        : '',
        provider            : '',
        apiEndpoint         : '',
        tokenExpire         : 0
    };

    self.DebugPrint = function (str) {

        if (self.playerInfo.debug === true) {
            //self.events.emit('debug',str)
            console.log(str);
        }

    };

    self.pokemonlist = pokemonlist.pokemon;

    function api_req(api_endpoint, access_token, req) {

        return new Promise(function(resolve,reject) {

            var auth = new RequestEnvelop.AuthInfo({
                provider    : self.playerInfo.provider,
                token       : new RequestEnvelop.AuthInfo.JWT(access_token, 59)
            });

            var f_req = new RequestEnvelop({
                unknown1    : 2,
                rpc_id      : 1469378659230941192,

                requests    : req,

                latitude    : self.playerInfo.latitude,
                longitude   : self.playerInfo.longitude,
                altitude    : self.playerInfo.altitude,

                auth        : auth,
                unknown12   : 989
            });

            var protobuf = f_req.encode().toBuffer();

            var options = {
                url         : api_endpoint,
                body        : protobuf,
                encoding    : null,
                headers     : {
                    'User-Agent' : 'Niantic App'
                }
            };

            self.request.post(options, function (err, response, body) {

                if (response === undefined || body === undefined) return reject('RPC Server offline');

                try {
                    var f_ret = ResponseEnvelop.decode(body);
                } catch (e) {
                    if (e.decoded) { // Truncated
                        f_ret = e.decoded;
                    }
                }

                if (f_ret) {
                    return resolve(f_ret);
                }

                resolve(api_req(api_endpoint, access_token, req));
            });
        });
    }

    self.init = function (username, password, location) {
        self.playerInfo.provider = /@gmail\.com$/i.test(username) ? 'google' : 'ptc';

        return self.SetLocation(location)
            .then(() => self.GetAccessToken(username,password))
            .then(() => self.GetApiEndpoint());
    };

    self.GetAccessToken = function (user,pass) {
        return new Promise(function(resolve,reject) {
            self.DebugPrint('[i] Logging with user: ' + user);

            if (self.playerInfo.provider === 'ptc') {
                Logins.PokemonClub(user, pass, self, function (err, token) {
                    if (err) return reject(err);

                    self.playerInfo.accessToken = token[0];
                    self.playerInfo.tokenExpire = token[1];
                    self.DebugPrint('[i] Received PTC access token! {Expires: ' + token[1] + '}');
                    resolve(token[0]);
                });
            } else {
                Logins.GoogleAccount(user, pass, self, function (err, token) {
                    if (err) return reject(err);

                    self.playerInfo.accessToken = token[0];
                    self.playerInfo.tokenExpire = token[1];
                    self.DebugPrint('[i] Received Google access token! {Expires: ' + token[1] + '}');
                    resolve(token[0]);
                });
            }
        });
    };


    self.GetApiEndpoint = function () {
        var req = [
            new RequestEnvelop.Requests(2),
            new RequestEnvelop.Requests(126),
            new RequestEnvelop.Requests(4),
            new RequestEnvelop.Requests(129),
            new RequestEnvelop.Requests(5)
        ];

        return api_req(api_url, self.playerInfo.accessToken, req)
            .then(function (f_ret) {
                var api_endpoint = `https://${f_ret.api_url}/rpc`;
                self.playerInfo.apiEndpoint = api_endpoint;
                self.DebugPrint('[i] Received API Endpoint: ' + api_endpoint);

                return api_endpoint;
            });
    };
    
    self.GetInventory = function() {
        var req = new RequestEnvelop.Requests(4);

        return api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req)
                .then(function(f_ret) {
                    var inventory = ResponseEnvelop.GetInventoryResponse.decode(f_ret.payload[0]);
                    resolve(inventory);
                });
    };

    self.GetProfile = function () {
        var req = new RequestEnvelop.Requests(2);

        return api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req)
            .then(function (f_ret) {
                var profile = ResponseEnvelop.ProfilePayload.decode(f_ret.payload[0]).profile;

                if (!profile.username) {
                    throw 'Unexpected error ocurred.';
                }

                self.DebugPrint('[i] Logged in!');

                return profile;
            });
    };

    // IN DEVELPOMENT, YES WE KNOW IS NOT WORKING ATM
    self.Heartbeat = function (callback) {
        let {apiEndpoint,accessToken} = self.playerInfo;


        var nullbytes = new Array(21);
        nullbytes.fill(0);

        // Generating walk data using s2 geometry
        var walk = getNeighbors(self.playerInfo.latitude, self.playerInfo.longitude).sort(function (a, b) {
            return a > b;
        });

        // Creating MessageQuad for Requests type=106
        var walkData = new RequestEnvelop.MessageQuad({
            'f1': walk,
            'f2': nullbytes,
            'lat': self.playerInfo.latitude,
            'long': self.playerInfo.longitude
        });

        var req = [new RequestEnvelop.Requests(106, walkData.encode().toBuffer()), new RequestEnvelop.Requests(126), new RequestEnvelop.Requests(4, new RequestEnvelop.Unknown3(Date.now().toString()).encode().toBuffer()), new RequestEnvelop.Requests(129), new RequestEnvelop.Requests(5, new RequestEnvelop.Unknown3('05daf51635c82611d1aac95c0b051d3ec088a930').encode().toBuffer())];

        api_req(apiEndpoint, accessToken, req, function (err, f_ret) {
            if (err) {
                return callback(err);
            } else if (!f_ret || !f_ret.payload || !f_ret.payload[0]) {
                return callback('No result');
            }

            var heartbeat = ResponseEnvelop.HeartbeatPayload.decode(f_ret.payload[0]);
            callback(null, heartbeat);
        });
    };

    self.GetLocation = function (callback) {
        return new Promise(function(resolve,reject) {
            geocoder.reverseGeocode(...GetCoords(self), function (err, data) {
                if (data.status === 'ZERO_RESULTS') {
                    return reject('Location not found');
                }

                resolve(data.results[0].formatted_address);
            });
        });
    };

    self.CatchPokemon = function (mapPokemon, pokeball, callback) {
        console.log('Attempting to catch now...');

        let {apiEndpoint,accessToken} = self.playerInfo;

        var catchPokemon = new RequestEnvelop.CatchPokemonMessage({
            'encounter_id'                  : mapPokemon.EncounterId,
            'pokeball'                      : pokeball,
            'normalized_reticle_size'       : 1.950,
            'spawnpoint_id'                 : mapPokemon.SpawnPointId,
            'hit_pokemon'                   : true,
            'spin_modifier'                 : 1,
            'normalized_hit_position'       : 1
        });

        var req = new RequestEnvelop.Requests(103,catchPokemon.encode().toBuffer());

        return api_req(apiEndpoint, accessToken, req)
            .then(function(f_ret) {
                if (!f_ret || !f_ret.payload || !f_ret.payload[0]) throw 'No result';

                return ResponseEnvelop.CatchPokemonResponse.decode(f_ret.payload[0]);
            });

    };

    self.EncounterPokemon = function (catchablePokemon, callback) {
        // console.log(catchablePokemon);
        let {apiEndpoint, accessToken, latitude, longitude} = self.playerInfo;

        var encounterPokemon = new RequestEnvelop.EncounterMessage({
            'encounter_id'          : catchablePokemon.EncounterId,
            'spawnpoint_id'         : catchablePokemon.SpawnPointId,
            'player_latitude'       : latitude,
            'player_longitude'      : longitude
        });

        // console.log(encounterPokemon);

        var req = new RequestEnvelop.Requests(102, encounterPokemon.encode().toBuffer());

        return api_req(apiEndpoint, accessToken, req)
            .then(function(f_ret) {
                if (!f_ret || !f_ret.payload || !f_ret.payload[0]) throw 'No result';

                return ResponseEnvelop.EncounterResponse.decode(f_ret.payload[0]);
            });

    };

    self.GetLocationCoords = function () {
        let { latitude , longitude , altitude} = self.playerInfo;
        return { latitude, longitude , altitude};
    };

    self.SetLocation = function (loc) {
        return new Promise(function(resolve,reject) {

            let location = {};

            if (typeof loc == 'string' && loc) {
                location.type = 'name';
                location.name = loc;
            } else if (typeof loc == 'object' && !Array.isArray(loc) && loc.latitude && loc.longitude) {
                location.type = 'coords';
                location.coords = _.defaults(_.pic(loc,['latitude','longitude','altitude']),{altitude:0});
            } else {
                return reject('Invalid location');
            }

            if (location.type === 'name') {

                geocoder.geocode(location.name, function (err, data) {

                    if (err || data.status === 'ZERO_RESULTS') {
                        return reject('location not found');
                    }

                    let { lat , lng} = data.results[0].geometry.location;

                    self.playerInfo.latitude        = lat;
                    self.playerInfo.longitude       = lng;
                    self.playerInfo.locationName    = location.name;

                    resolve(self.GetLocationCoords());

                });

            }

            self.playerInfo.latitude            = location.coords.latitude || self.playerInfo.latitude;
            self.playerInfo.longitude           = location.coords.longitude || self.playerInfo.longitude;
            self.playerInfo.altitude            = location.coords.altitude || self.playerInfo.altitude;

            geocoder.reverseGeocode(...GetCoords(self), function (err, data) {
                if (data.status !== 'ZERO_RESULTS' && data.results && data.results[0]) {
                    self.playerInfo.locationName = data.results[0].formatted_address;
                }

                resolve(self.GetLocationCoords());
            });
        });
    };

    self.changePosition = function () {
        self.playerInfo.longitude = self.playerInfo.longitude + 0.000055;
        self.playerInfo.latitude = self.playerInfo.latitude + 0.000055;
        return true;
    };

    self.hatchEggs = function(cb) {
        self.changePosition();
        self.Heartbeat(cb);
    };

    self.GetFort = function(fortid, fortlat, fortlong, callback) {
        var FortMessage = new RequestEnvelop.FortSearchMessage({
            'fort_id': fortid,
            'player_latitude': fortlat,
            'player_longitude': fortlong,
            'fort_latitude': fortlat,
            'fort_longitude': fortlong
        });

        var req = new RequestEnvelop.Requests(101, FortMessage.encode().toBuffer());

        return api_req(self.playerInfo.apiEndpoint, self.playerInfo.accessToken, req)
            .then(function(f_ret) {
                if (!f_ret || !f_ret.payload || !f_ret.payload[0]) throw 'No result';

                return ResponseEnvelop.FortSearchResponse.decode(f_ret.payload[0]);
            });
    };

    self.warpSpeed = function(lat,long) {
        self.playerInfo.latitude = lat;
        self.playerInfo.longitude = long;
        return true;
    };
}

module.exports = new Pokeio();
module.exports.Pokeio = Pokeio;
//module.exports.Pokego = require('./pokego.js');
