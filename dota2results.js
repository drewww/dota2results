var request = require('request'),
	winston = require('winston'),
	querystring = require('querystring'),
	_ = require('underscore')._,
	dazzle = require('dazzle'),
	twit = require('twit');

var config = require('./config.json');
var api = new dazzle(config.steam.key);

winston.info("dota2results STARTING");


api.getMatchHistory({tournament_games_only:1, matches_requested: 1}, function(err, res) {
	winston.info("loading details for match " + res.matches[0].match_id);
	// now get the tournament details
	api.getMatchDetails(res.matches[0].match_id, function(err, match) {

		var teams = [];
		_.each(["radiant", "dire"], function(name) {
			var team = {};
			_.each(["name", "team_id", "logo", "team_complete"], function(param) {
				team[param] = match[name+"_"+param];
			});
			teams.push(team);
			winston.info(team);
		});

		
	});
});

// The desired tweet looks like this:
// TOURNAMENT GAME N: TEAM def TEAM in TIME
// 


winston.info("dota2results ENDING");
