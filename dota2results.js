var request = require('request'),
	winston = require('winston'),
	querystring = require('querystring'),
	_ = require('underscore')._,
	dazzle = require('dazzle'),
	EventEmitter = require('events').EventEmitter,
	twit = require('twit');

var config = require('./config.json');
var api = new dazzle(config.steam.key);

winston.cli();
winston.info("dota2results STARTING");

var leagues;


// basic arc of it:
// on startup, load league listing.
// check active games periodically, tracking match ids.
// when a match id falls off the active games list, request its deets.
// process it.
// 
// DITCH MATCH HISTORY BECAUSE IT LIES

// lifecycle: look at 

// option 1:
//	every N seconds, look at one match from every league and spit it out
//	


exports.ResultsServer = function() {

}

exports.ResultsServer.prototype = {
	leagues: null,
	lastLeagueUpdate: null,

	liveGames: null,
	lastLiveGamesUpdate: null,

	mostRecentLeagueMatchIds: null,

	init: function() {
		winston.info("INIT ResultsServer");

		// a hash from league_id to most recently
		// updated match_id for that league.
		this.mostRecentLeagueMatchIds = {};
	},

	start: function() {
		winston.info("START ResultsServer");

		// this.on("leagues:update", this.checkRecentLeagueGames);
		this.updateLeagueListing();
		this.on("live-games:update", _.bind(function() {
			var leagues = this.getLiveLeagues();

			_.each(leagues, _.bind(function(leagueId) {
				this.getLeagueMatches(leagueId);
			}, this));

		}, this));

		this.on("leagues:update", this.updateLiveGamesListing);
	},

	stop: function() {
		winston.info("STOP ResultsServer");

	},

	destroy: function() {
		winston.info("DESTROY ResultsServer");

	},

	checkRecentLeagueGames: function() {
		_.each(this.leagues, _.bind(function(league) {
			winston.info("loading league " + league.name);
			this.getLeagueMatches(league.leagueid);
		}, this));
	},

	updateLeagueListing: function() {
		this.api().getLeagueListing(_.bind(function(err, res) {
			if(err) {
				winston.error("Error loading league listing: " + err);
				return;
			}


			var that = this;
			this.leagues = {};
			_.each(res.leagues, function(league) {
				that.leagues[league.leagueid] = league;
			});

			this.lastLeagueUpdate = new Date().getTime();

			this.emit("leagues:update");
		}, this));
	},

	updateLiveGamesListing: function() {
		this.api().getLiveLeagueGames(_.bind(function(err, res) {
			if(err) {
				winston.error("Error loading live league games: " + err);
				return;
			}

			this.liveGames = res.games;
			this.lastLiveGamesUpdate = new Date().getTime();

			this.emit("live-games:update");
		}, this));
	},

	getLiveLeagues: function() {
		var leagueIds = _.map(this.liveGames, function(game) {
			return game.league_id;
		});

		return leagueIds;
	},

	getLeagueMatches: function(leagueId) {

		winston.info("getting league matches for id " + leagueId);
		this.api().getMatchHistory({
			matches_requested: 1,
			league_id: leagueId
		}, _.bind(function(err, res) {
			if(err) {
				winston.error("error loading matches: " + err);
				return;
			}

			var league = this.leagues[leagueId];

			if(res.total_results == 0) {
				winston.info("No matches returned for league_id: " + leagueId);
				return;
			} else {
				winston.info(res.total_results + " matches found for " + league.name);
			}

			_.each(res.matches, function(match) {
				winston.info("\t" + match.match_id + "/" + match.match_seq_num + " @" + new Date(match.start_time*1000).toISOString());
			});

		}, this));
	},

	processFinishedMatch: function(matchId) {
		this.api().getMatchDetails(matchId, function(err, match) {

			if(err) {
				winston.error("error loading match: " + err);
				return;
			}

			var teams = [];
			_.each(["radiant", "dire"], function(name) {
				var team = {};
				_.each(["name", "team_id", "logo", "team_complete"], function(param) {
					team[param] = match[name+"_"+param];
				});
				team["side"] = name;

				teams.push(team);
				winston.info(team);
			});

			if(!match.radiant_win) {
				var winner = teams[1];
				teams[1] = teams[0];
				teams[0] = winner;
			}

			var durationString = Math.floor(match.duration/60) + ":" + match.duration%60;
			var league = this.leagues[match.league_id];

			winston.info(teams[0].name + " DEF " + teams[1].name + "(" + durationString + ") in " + league.name);
		});
	},

	api: function() {
		return new dazzle(config.steam.key);
	}
};

_.extend(exports.ResultsServer.prototype, EventEmitter.prototype);



// api.getLeagueListing(function(err, res) {
// 	leagues = res.leagues;
// 	winston.info("loaded " + leagues.length + " leagues");

// 	var now = Math.floor(new Date().getTime()/1000);
// 	var then = now-(60*60*24);

// 	winston.info("requesting matches between: " + now + " and " + then);
// 	api.getMatchHistory({
// 		tournament_games_only:1,
// 		// date_max: now,
// 		// date_min: then
// 	}, function(err, res) {

// 		if(err) {
// 			winston.error(err);
// 			return;
// 		}

// 		if(res.num_results==0) {
// 			winston.info("No matches within the last " + (now - then) + " seconds.");
// 			return;
// 		}

// 		_.each(res.matches, function(match) {
// 			// now get the tournament details
// 			winston.info("loading details for match " + match.match_id);

// 		})
// 	});
// });




// The desired tweet looks like this:
// TOURNAMENT GAME N: TEAM def TEAM in TIME
// 

var server = new exports.ResultsServer();

server.init();
server.start();


process.on('uncaughtException', function(err) {
  winston.error(err.stack);
});


