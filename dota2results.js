var request = require('request'),
	winston = require('winston'),
	querystring = require('querystring'),
	dazzle = require('dazzle'),
	twit = require('twit');

var config = require('./config.json');
var api = new dazzle(config.steam.key);

winston.info("dota2results STARTING");


api.getMatchHistory({tournament_games_only:1, matches_requested: 1}, function(err, res) {
	winston.info(JSON.stringify(res));
});


winston.info("dota2results ENDING");
