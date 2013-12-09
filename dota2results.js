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


// Here's the flow:
// 	1. On startup, get a list of leagues. Store it.
// 	2. Do a pass across each of those leagues and ask for most recent match.
// 	3. Log those match ids as "most recent match seen" for each of the leagues.
//  4. Start the main update loop, once every 60 seconds.
//		a. Check to see if our league listing is greater than 24 hours out of date.
//			If it is, refresh it.
//		b. Hit the live league games list. Not to farm match_ids (which aren't shown there)
//			but to get a list of which leagues to check.
//		c. Compare the list of most recent games for each of the live leagues to
//			the list of last games we've seen for that league.
//		d. If it's a new id, then fetch the full match history for it and tweet it up. 
//	


exports.ResultsServer = function() {

}

exports.ResultsServer.prototype = {
	leagues: null,
	lastLeagueUpdate: null,

	liveGames: null,
	lastLiveGamesUpdate: null,

	mostRecentLeagueMatchIds: null,

	lastActiveLeagueIds: null,

	starting: true,

	updater: null,

	init: function() {
		winston.info("INIT ResultsServer");

		// a hash from league_id to most recently
		// updated match_id for that league.
		this.mostRecentLeagueMatchIds = {};

		this.lastActiveLeagueIds = [];
	},

	start: function() {
		winston.info("START ResultsServer");

		this.twitter = new twit({
		    consumer_key:         config.twitter.consumer_key
		  , consumer_secret:      config.twitter.consumer_secret
		  , access_token:         config.twitter.access_token
		  , access_token_secret:  config.twitter.access_token_secret
		});

		this.on("live-games:update", _.bind(function() {
			var leagues = this.getLeaguesWithLiveGames();

			// special case for first run
			if(_.isNull(this.lastActiveLeagueIds)) {
				this.lastActiveLeagueIds = leagues;
			}

			// always run on the last set not this set, because if a game
			// just ended its league might not be in the current list
			// anymore.

			winston.info("Checking leagueIds: " + JSON.stringify(this.lastActiveLeagueIds));

			// delay this check to give steam time to get the match up. Sometimes
			// we check too quickly and we miss a new game because it's not in
			// the match history yet.
			setTimeout(_.bind(function() {
				_.each(this.lastActiveLeagueIds, _.bind(function(leagueId) {
					this.getMostRecentLeagueMatch(leagueId, _.bind(function(match) {
						this.logRecentMatch(match, this.leagues[leagueId], false);
					}, this));
				}, this));

				this.lastActiveLeagueIds = leagues;
			}, this), 20000);
		}, this));

		// when we get an update to the league listings (rare, but it happens) 
		// run a full update against all the leagues. but only if it's a 
		// startup run. 
		this.on("leagues:update", _.bind(function() {
			// when leagues update, first do a pass to get
			// their most recent match ids.
			_.each(Object.keys(this.leagues), _.bind(function(leagueId) {
				var league = this.leagues[leagueId];

				this.getMostRecentLeagueMatch(leagueId, _.bind(function(match) {
					// log the matches, but supress tweets, since this is
					// only running on startup.
					this.logRecentMatch(match, league, this.starting);

					// on first run supress, but subsequent updates to the 
					// league list shouldn't supress updates in case a game
					// collides with a league update operation.
				}, this));
			}, this));
		}, this));

		this.updateLeagueListing();

		// now kick off a periodic live games update.
		this.updater = setInterval(_.bind(function() {
			this.checkForLiveLeagueGames();

			this.starting = false;
		}, this), 60*1000);
	},

	stop: function() {
		winston.info("STOP ResultsServer");

		clearInterval(this.updater);
	},

	destroy: function() {
		winston.info("DESTROY ResultsServer");
	},

	logRecentMatch: function(match,league, suppressProcessing) {
		// first, check it against the league listing.
		if(league.mostRecentMatchId==match.match_id) {
			winston.debug("Match_id matches most recent id for league.")
			return;
		} else {
			league.mostRecentMatchId = match.match_id;

			winston.info("Found new match for league " + league.name);
			if(suppressProcessing) {
				return;
			}

			// otherwise, tweet the game.
			this.processFinishedMatch(match.match_id);
		}
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

			winston.info("Loaded " + Object.keys(this.leagues).length + " leagues.");

			this.lastLeagueUpdate = new Date().getTime();

			this.emit("leagues:update");
		}, this));
	},

	checkForLiveLeagueGames: function() {
		this.api().getLiveLeagueGames(_.bind(function(err, res) {
			if(err) {
				winston.error("Error loading live league games: " + err);
				return;
			}

			this.liveGames = res.games;
			this.lastLiveGamesUpdate = new Date().getTime();

			winston.info("Found " + this.liveGames.length + " active league games.");

			this.emit("live-games:update");
		}, this));
	},

	getLeaguesWithLiveGames: function() {
		var leagueIds = _.map(this.liveGames, function(game) {
			return game.league_id;
		});

		return leagueIds;
	},

	getMostRecentLeagueMatch: function(leagueId, cb) {
		var league = this.leagues[leagueId];

		winston.debug("Getting most recent match for " + league.name);

		this.api().getMatchHistory({
			matches_requested: 1,
			league_id: leagueId
		}, _.bind(function(err, res) {
			if(err) {
				winston.error("error loading matches: " + err);
				return;
			}

			if(res.total_results == 0) {
				winston.warn("No matches returned for league_id: " + league.name);
				return;
			} else {
				winston.debug(res.total_results + " matches found for " + league.name);
			}

			// there should only be 1 match, since we only requested 1.
			var match = res.matches[0];
			winston.debug("\t" + match.match_id + "/" + match.match_seq_num + " @" + new Date(match.start_time*1000).toISOString());
			
			// run the callback if present.
			cb && cb(match);
		}, this));
	},

	processFinishedMatch: function(matchId) {
		this.api().getMatchDetails(matchId, _.bind(function(err, match) {
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
			});

			if(!match.radiant_win) {
				var winner = teams[1];
				teams[1] = teams[0];
				teams[0] = winner;
			}

			var durationString = Math.floor(match.duration/60) + ":" + match.duration%60;
			var league = this.leagues[match.leagueid];

			winston.info("Processing match between " + teams[0].name + " and " + teams[1].name);

			var tweetString = teams[0].name + " DEFEATS " + teams[1].name + " (" + durationString + ") in " + league.name;

			if(_.isUndefined(teams[0].name) || _.isUndefined(teams[1].name)) {
				winston.warn("Found team with undefined name. Probably a pickup league, ignoring. Tweet would have been: " + tweetString);
				return;
			}


			if(tweetString.length > 140) {
				tweetString = tweetString.substring(0, 139);
			}

			winston.info("TWEET: " + tweetString);
			this.twitter.post('statuses/update', { status: tweetString }, function(err, reply) {
				if (err) {
	  				winston.error("Error posting tweet: " + err);
				} else {
	  				winston.debug("Twitter reply: " + reply + " (err: " + err + ")");
				}
  			});
		}, this));
	},

	api: function() {
		return new dazzle(config.steam.key);
	}
};

_.extend(exports.ResultsServer.prototype, EventEmitter.prototype);



/////////////////////////////////////////////////////
//					STARTUP 					   //
/////////////////////////////////////////////////////

var server = new exports.ResultsServer();

server.init();
server.start();


process.on('uncaughtException', function(err) {
  winston.error(err.stack);
});


