var request = require('request'),
	winston = require('winston'),
	querystring = require('querystring'),
	boxscores = require('./lib/boxscores.js'),
	_ = require('underscore')._,
	dazzle = require('dazzle'),
	EventEmitter = require('events').EventEmitter,
	fs = require('fs'),
	twit = require('twit'),
	mandrill = require('mandrill-api/mandrill'),

	team_twitter = require('./lib/twitter_handles.js').teams,
	GameStates = require('./lib/gamestate.js');


if("REDISCLOUD_URL" in process.env) {
	var redis = require('redis'),
		url = require('url');
}

var mc = null;
if("MANDRILL_KEY" in process.env) {
	var mc = new mandrill.Mandrill(process.env["MANDRILL_KEY"]);
}

winston.cli();
winston.info("dota2results STARTING");

// Here's the overall system flow:
// 	1. On startup, get a list of leagues. Store it.
//  2. Start the main update loop, once every 60 seconds.
//		a. Check to see if our league listing is greater than 24 hours out of date.
//			If it is, refresh it.
//		b. Hit the live league games list. Not to farm match_ids (which aren't shown there)
//			but to get a list of which leagues to check.
//				- if we don't have a list of already-seen matchIds, then start one.
//		c. Compare the list of most recent games for each of the live leagues to
//			the list of last games we've seen for that league.
//		d. If it's a new id, then fetch the full match history for it and tweet it up.

// There's a lot of demand for delaying tweets by two minutes. Options for this:
//	1. Just do a settimeout on the tweets.
//		The problem with this strategy is that if the server restarts in that 2 min window, tweets are lost.
//	2. So, when a match finishes, add it to redis (if redis is present) and do a settimeout of the actual tweet. In that settimeout, remove the id from redis.
//		We're protected from double-tweets by twitter API, so that failure mode is handled.
//		It's a little annoying to test this without local redis. But I guess I can deal.
// So the pieces of this are:
//		1. Delay all outgoing tweets.
//		2. Make a note of currently-delayed match Ids, put in redis.
//		3. After delay, tweet + remove matchId from list.
//				There's a minor failure mode here; if server shuts down between tweet + removal, it will re-tweet it next time the server starts.
// Wait a second, lets tink about the actual failure mode here:
// 1. Get the match-finished event.
// 2. Process the match, but setTimeout the actual tweet.
// 3. Server restarts before the tweet goes out.
// 4. Server reloads, discovers a tweet in the redis queue. Sends it immediately.
//		- this case is a little weird and could cause a tweet go out not as delayed
//			as it should. But I don't think we can afford to sweat that.
//		- only way around that would be to add a time component and that's annoying.
//		- we should think of this whole system as insurance, and it's okay if we
//			make a small mistake in timing.

exports.ResultsServer = function() {

}

exports.ResultsServer.prototype = {
	leagues: null,
	lastLeagueUpdate: null,

	teams: null,
	lastTeamUpdate: null,

	liveGames: null,
	lastLiveGamesUpdate: null,

	activeSeriesIds: null,

	starting: true,

	updater: null,

	activeLeagueIds: null,

	leagueStreamDelays: null,
	leagueTier: null,

	blacklistedLeagueIds: null,

	isDemo: false,

	matchesToTweet: null,

	redis: null,

	subscribers: null,

	matchDetailsCache: null,

	states: null,

	init: function(isDemo, isSilent) {
		winston.info("INIT ResultsServer");

		// maps leagueIds to times we last saw that league
		// with an active game.
		this.activeLeagueIds = {};

		// maps league_ids to stream delays, in seconds.
		this.leagueStreamDelays = {};

		// maps league_ids to league_tiers, an enumerated int: 1, 2, 3
		this.leagueTier = {};

		// the match details cache relates match_ids to a full
		// JSON response from the server. They're cleaned out
		// at the same time as matchesToTweet is cleaned out,
		// to avoid them accumulating forever.
		this.matchDetailsCache = {};

		try {
			this.leagues = require('/tmp/leagues.json');
			this.lastLeagueUpdate = new Date().getTime();
		} catch (e) {
			this.leagues = {};
		}

		this.subscribers = [];
		if("SUBSCRIBERS" in process.env) {
			this.subscribers = JSON.parse(process.env.SUBSCRIBERS);
			winston.info("Initialized subscriber list: " +
				JSON.stringify(this.subscribers));
		}

		this.matchesToTweet = [];

		// activeSeriesIds tracks the win/loss patterns in currently-active
		// series (ie bo3, bo5, etc)
		// individual games don't return this information, but the match_history
		// listings tell us whether a match is part of a series and how long
		// that series should be. If we see a series_id that's new, we'll
		// add it here (key=>series_id) and whenever we see a win/loss for that
		// series_id we'll update it. We'll identify teams within the record with
		// another {} with the keys as team_ids and the values as wins.
		//
		// we'll clean these out when we've seen enough wins (ie 2 for a bo3, 3 for a bo5)
		// OR when we haven't updated the entry for three days. This should only
		// really happen if we start this mid-series for anything. But it's important to
		// avoid a memory leak.
		this.activeSeriesIds = {};

		// auto-discard any super rapid tweets
		// this will cull some of the potential horror of auto tweeting
		// every result in the list. Might also catch legit multiple games
		// ending in rapid succession; i'm not sure yet.
		this.tweet = _.throttle(this._tweet, 500);
		this.altTweet = _.throttle(this._altTweet, 500);

		// look for whitelisted leagueIds. 
		this.whitelistedLeagueIds = JSON.parse(process.env.WHITELISTED_LEAGUE_IDS);

		this.isDemo = isDemo;
		this.isSilent = isSilent;

		if("REDISCLOUD_URL" in process.env) {
			var redisURL = url.parse(process.env.REDISCLOUD_URL);

			this.redis = redis.createClient(redisURL.port, redisURL.hostname, {no_ready_check: true});

			// If it seems like the URL isn't a local redis DB, then do the auth
			// operation. If we're on localhost, we don't need to do this.
			if(process.env.REDISCLOUD_URL.indexOf('localhost')==-1) {
				this.redis.auth(redisURL.auth.split(":")[1]);
			}

			this.redis.on("connect", _.bind(function() {
				winston.info("Connected to redis!");
				this.loadSeries();
				this.loadDelayedMatches();

				// eventually this will also trigger game states to load
				// from redis.
				this.states = new GameStates(this.redis, isSilent);

				this.states.on("game-over", _.bind(function(matchId, leagueId) {
					winston.info("GAME OVER CALLBACK");
					if(leagueId==600) {
						winston.info("got a game over event on a TI4 game, processing it");
						this.logRecentMatch({match_id:matchId}, this.leagues[leagueId]);
					}
				}, this));

			}, this));
		} else {
			winston.warn("Redis connection information not available.");
			this.loadSeries();
			this.loadDelayedMatches();
		}
	},

	start: function() {
		winston.info("START ResultsServer");

		this.twitter = new twit({
		    consumer_key:         process.env.TWITTER_CONSUMER_KEY
		  , consumer_secret:      process.env.TWITTER_CONSUMER_SECRET
		  , access_token:         process.env.TWITTER_ACCESS_TOKEN
		  , access_token_secret:  process.env.TWITTER_ACCESS_TOKEN_SECRET
		});

		this.twitterAlt = new twit({
		    consumer_key:         process.env.TWITTER_ALT_CONSUMER_KEY
		  , consumer_secret:      process.env.TWITTER_ALT_CONSUMER_SECRET
		  , access_token:         process.env.TWITTER_ALT_ACCESS_TOKEN
		  , access_token_secret:  process.env.TWITTER_ALT_ACCESS_TOKEN_SECRET
		});

		// debouncing this call makes sure that it doesn't get called in rapid succession, which in some
		// situations seemed to cause double tweeting / double processing of a single match. Adding a few
		// seconds of delay in here will avoid that, I think.
		this.on("live-games:update", _.debounce(_.bind(function() {
			var leagues = this.getLeaguesWithLiveGames();

			_.each(leagues, _.bind(function(league) {
				this.activeLeagueIds[league] = new Date().getTime();
			}, this));

			_.each(Object.keys(this.activeLeagueIds), _.bind(function(league) {
				var lastSeen = this.activeLeagueIds[league];

				var now = new Date().getTime();

				// if it's been more than ten minutes, stop checking.
				if((now - lastSeen) > (1000*60*10)) {
					winston.info("Discarding " + league + " from tracking; been too long since we've seen it.");
					delete this.activeLeagueIds[league];
				}
			}, this));

			// always run on the last set not this set, because if a game
			// just ended its league might not be in the current list
			// anymore.
			var matchCounts = {};
			var missingLeague = false;

			winston.info(JSON.stringify(this.activeLeagueIds));

			// this stupid league breaking things during TI
			try {
				delete this.activeLeagueIds[1645];				
			} catch (e) {
				// do nothing
			}

			_.each(Object.keys(this.activeLeagueIds), _.bind(function(leagueId) {
				var league = this.leagues[leagueId];

				// short circuit the whole loop if we're missing a league.
				// if(missingLeague) return;

				if(_.isUndefined(league)) {
					winston.error("League is not defined for " + leagueId);
					// Not really sure what to do in this case.
					// really we need to create a new entry in this list, but I'm not sure
					// what it should have in it.

					// OH I know what happened. The patch hit, new tickets went out, and
					// we didn't have them in the list. I think we need to do a full league
					// update operation.

					// this is a little error prone. The update league listing takes time,
					// and if league is undefined, the next check is DEFINITELY going to fail.
					// really we want to update the league listing, wait for that to execute
					// and then return to this proces. 
					// this.updateLeagueListing();
					// missingLeague = true;
					return;
				}

				if(_.isUndefined(league.lastSeenMatchIds)) {
					winston.info("Found un-initialized league: " + league.name);
					league.lastSeenMatchIds = [];
					league.init = true;
				}

				this.getRecentLeagueMatches(leagueId, _.bind(function(matches) {
					// winston.info("Found " + matches.length + " matches for league: " + this.leagues[leagueId].name);

					matchCounts[leagueId] = matches.length;

					this.leagues[leagueId].init = false;

					// ugly but I'm too lazy to work out the flow control here.
					if(Object.keys(matchCounts).length==Object.keys(this.activeLeagueIds).length) {
						var out = "";

						_.each(Object.keys(matchCounts), function(k) {
							out += k + ":" + matchCounts[k] + "\t";
						});

						winston.info(this.liveGames.length + " -> " + out + " (states: " + Object.keys(this.states.lobbies).length + ")");
					}
				}, this));
			}, this));
			this.saveLeagues();

			// now check and see if any matches didn't get successfully processed. If so,
			// reprocess them. (reminder: this happens every live-games:update, not on
			// server start. This is how we deal with failures; we retry them in this
			// loop until they succeed and get removed from the list.)

			if(this.matchesToTweet.length > 0) {
				winston.info(this.matchesToTweet.length + " queued matches that haven't been successfully tweeted, retrying now: " + JSON.stringify(this.matchesToTweet));
				_.each(this.matchesToTweet, _.bind(function(match) {
					this.loadMatchDetails(match, _.bind(this.handleFinishedMatch, this));
				}, this));
			}

			// now we're going to dig into the snapshots in this list to process their
			// snapshots. Probably we're going to want to mess with the frequencies of
			// this part of the processing relative to the other pieces, but for now
			// we'll let them all line up.
			_.each(this.liveGames, _.bind(function(game) {
				this.states.processSnapshot(game);
			}, this));

			// triggers some cleanup at the end of a set of snapshots.
			this.states.finish();
		}, this), 5000));

		if(Object.keys(this.leagues).length==0) {
			this.updateLeagueListing();
		}

		// this is artificially low for testing purposes.
		// in production, probably set this high again.
		var duration = 90*1000;
		if(this.isDemo) {
			// we want to pick a random league that's not blacklisted
			// and tweet from it occasionally.
			var legalLeagueIds = _.filter(Object.keys(this.leagues), _.bind(function(id) {
				return !_.contains(this.blacklistedLeagueIds, id);
			}, this));

			winston.info(JSON.stringify(legalLeagueIds));

			this.updater = setInterval(_.bind(function() {
				var rand = Math.floor(Math.random()*legalLeagueIds.length);

				var leagueId = legalLeagueIds[rand];

				winston.info("Demoing: " + leagueId);

				this.leagues[leagueId].demo = true;
				this.leagues[leagueId].lastSeenMatchIds = [];

				this.getRecentLeagueMatches(leagueId);
			}, this), 5000);
		} else {
			// now kick off a periodic live games update.
			// this is the core loop for the bot;
			// every `duraton` ms it hits liveLeagueGames
			// and looks for a state change that we need to
			// be aware of. 
			this.updater = setInterval(_.bind(function() {
				this.checkForLiveLeagueGames();

				// once a day, do a full leaguelisting update
				var now = new Date().getTime();
				if(now - this.lastLeagueUpdate > (24*60*60*1000)) {
					this.updateLeagueListing();
				}
			}, this), duration);
		}
	},

	stop: function() {
		winston.info("STOP ResultsServer");

		clearInterval(this.updater);
	},

	destroy: function() {
		winston.info("DESTROY ResultsServer");
	},

	// when we're gong to actually process a completed match,
	// this is the method to call. This will eventually lead
	// to a tweet being fired off, if appropriate. 
	logRecentMatch: function(match,league) {
		// winston.info("logRecentMatch: " + match.match_id);
		// winston.info("league: " + JSON.stringify(league));
		// first, check it against the league listing.

		// lets load the league_tier into the match data so it's cached
		// properly.
		match.league_tier = this.leagueTier[league.leagueid];
		// winston.info("Inserting league_tier ("+match.league_tier+") into match " + match.match_id);

		if(_.contains(league.lastSeenMatchIds, match.match_id)) {
			// winston.info("match_id (" + match.match_id + ") has been seen already: " + JSON.stringify(league.lastSeenMatchIds) + " for league " + league.league_id);
			return;
		} else {
			// Even in the delay case, we want to adjust this list so that we don't
			// keep adding the delayed match to the list of tweets multiple times.
			// In the case where we shutdown after this point, it's okay; we'll work
			// it out on restart.
			if(league.lastSeenMatchIds) {
				league.lastSeenMatchIds.push(match.match_id);
			} else {
				winston.warn("Some weird issue with lastseen match ids: " + JSON.stringify(league));
			}

			// This check is basically making sure that we have already initialized
			// a league. If we haven't, every game in the league's history is going to
			// trigger a catch-up tweet when the server starts. So for the first time
			// we see a league, just store all its games and mark them as past.
			// This works every time except for the first game in a league, and I don't
			// super know what the right approach is there.
			if(!league.init) {
				// keep track of match ids that we want to tweet, and if they don't
				// get successfully processed (ie the get match details call fails, which
				// happens a distressing amount of the time) then try again later.

				// Delay all outgoing tweets. We delay both the addition of the match
				// info to the matchesToTweet list AND the immediate proccessing of the
				// tweet.
				winston.info("Delaying match handling for: " + match.match_id);
				// push the match info into redis, in case the server restarts before
				// we process this match.

				this.saveDelayedMatch(match);

				// now, we're going to issue a loadMatchDetails call that JUST sends
				// the email (if appropriate) rather than doing all the other stuff
				// related to official tweeting.

				// we could probably check to see if this league_id is blacklisted; if it
				// is, then we're not going to email anyway and could skip this load.
				// this.loadMatchDetails(match, _.bind(this.handleFinishedMatchEarly, this));

				// by default, delay for two minutes.
				var delayDuration = 1000*120;

				if(league.leagueid in this.leagueStreamDelays) {
					// this value is in seconds, so multiply by 1000 to get ms.
					delayDuration = this.leagueStreamDelays[league.leagueid] * 1000;
					winston.info("Pulling stream delay from cached value: " + delayDuration);
				} else {
					winston.info("Stream delay not found in cache; defaulting to 120s");
				}

				setTimeout(_.bind(function() {
					winston.info("\tDone delaying match handling for " + match.match_id);

					// add the match to the list of matches to tweet
					this.matchesToTweet.push(match);

					// attempt to proces the match immediately, which will remove it
					// from the above list if successful. If this particular process
					// attempt fails due to API errors, then the matchesToTweet checking
					// will catch it and try again later.
					this.loadMatchDetails(match, _.bind(this.handleFinishedMatch, this));
				}, this), delayDuration);
			} else if(league.demo) {
				// tweet the first thing we encounter just to test, then bail.
				this.loadMatchDetails(match, _.bind(this.handleFinishedMatch, this));
			} else {
				// winston.info("league init issue! league: " + JSON.stringify(league));
			}
		}
	},

	// Lots of league-specific data is cached since that endpoint
	// changes very infrequently. 
	updateLeagueListing: function() {
		winston.info("Updating league listing.");
		this.api().getLeagueListing(_.bind(function(err, res) {
			if(err) {
				winston.error("Error loading league listing: " + err);
				return;
			}

			if(_.isUndefined(res)) {
				winston.error("League listing request returned undefined result.");
				return;
			}

			var that = this;
			this.leagues = {};
			_.each(res.leagues, function(league) {
				if(league.leagueid in that.leagues) {
					var lastSeenMatchIds = that.leagues[league.leagueid].lastSeenMatchIds;
					league.lastSeenMatchIds = lastSeenMatchIds;
				}

				that.leagues[league.leagueid] = league;
			});

			winston.info("Loaded " + Object.keys(this.leagues).length + " leagues.");

			this.lastLeagueUpdate = new Date().getTime();

			this.emit("leagues:update");
			this.saveLeagues();
		}, this));
	},

	saveLeagues: function() {
		fs.writeFile("/tmp/leagues.json", JSON.stringify(this.leagues));
	},

	saveSeries: function() {
		if(this.redis) {
			this.redis.set("global:series", JSON.stringify(this.activeSeriesIds));
		} else {
			fs.writeFile("/tmp/series.json", JSON.stringify(this.activeSeriesIds));
		}
	},

	loadSeries: function() {
		if(this.redis) {
			this.redis.get("global:series", _.bind(function(err, reply) {
				if(!err) {
					this.activeSeriesIds = JSON.parse(reply ? reply : "{}");
					winston.info("Loading series from cache: " + JSON.stringify(this.activeSeriesIds));
				} else {
					winston.warn("Error loading series from cache: " + err + "; defaulting to empty.");
					this.activeSeriesIds = {};
				}
			}, this));
		} else {
			try {
				this.activeSeriesIds = JSON.parse(fs.readFileSync("/tmp/series.json", {encoding:"utf8"}));
			} catch (e) {
				winston.warn("Error loading series from disk, defaulting to empty.");
				this.activeSeriesIds = {};
			}

			winston.info("Loaded series from disk: " + JSON.stringify(this.activeSeriesIds));
		}
	},

	// If for whatever reason the server goes down while it's delaying a match
	// we want to make sure that it still tweets that match when the server is 
	// back online. We write a record of the delayed matches into redis, and then
	// load them back in on startup. Delaying is not a mistake or anything, it's
	// to make sure result tweets go out in sync with stream delays (which are 
	// reported by the API)
	loadDelayedMatches: function() {
		if(this.redis) {
			// get the whole list.
			// don't delete anything though, only do that on successful tweets.
			winston.info("Loading delayed match information from redis.");
			this.redis.hgetall("global:delayed_matches", _.bind(function(err, reply) {
				if(!err) {
					if(!_.isNull(reply) && reply.length==0) {
						winston.info("No delayed matches found.");
					}
					_.each(reply, _.bind(function(match, match_id) {
						// push it onto matchIdsToTweet
						winston.info("Pushing delayed matches onto list: " + match);
						this.matchesToTweet.push(JSON.parse(match));
					}, this));
				} else {
					winston.warn("Error loading delayed matches from cache: " + err);
				}
			}, this));
		} else {
			winston.warn("No support for loading delayed matches from disk.");
		}
	},

	saveDelayedMatch: function(match) {
		if(this.redis) {
			this.redis.hset("global:delayed_matches",match.match_id,JSON.stringify(match),
				function(err, reply) {
					if(err) {
						winston.warn("Error setting delayed match info: " + err);
					} else {
						winston.debug("Reply from setting deplayed match: " + reply);
					}
				});
		} else {
			winston.warn("No support for saving delayed matches to disk.");
		}
	},

	checkForLiveLeagueGames: function() {
		// winston.info("Checking for live games.");
		this.api().getLiveLeagueGames(_.bind(function(err, res) {
			if(err) {
				winston.error("Error loading live league games: " + err);
				return;
			}

			if(_.isUndefined(res)) {
				winston.warn("No live games found.");
				res = {games:[]};
				return;
			}

			this.liveGames = res.games;
			this.lastLiveGamesUpdate = new Date().getTime();

			// liveLeagueGames now reports stream delay properly. This is great,
			// because we've been guessing it thus far. The problem is there's
			// not an easy way to link liveLeagueGames with getMatchDetails
			// which is when we actually care about stream delay. The games when
			// they're live don't have a match_id, and the lobby_id they DO have
			// doesn't seem to be represented in the resulting match data.
			// 
			// what they do have in common is a league_id, which (it seems plausible)
			// is going to have a basically static stream delay. The big distinction
			// is between LAN events with little to no delay and online events which
			// have delays between 2 minutes and 6 minutes. We're going to assume
			// that the delay is basically stable for a league, and if it does change
			// within a league, it's during different stages of a tournament, not
			// between games. IE a tournament might start online and end lan and the
			// delay will change between those, but only once and not on a per-game
			// basis. So, here we're going to just build + maintain a hash of 
			// league ids to stream delays and update it every time we run this 
			// query, and check it when we're about to delay a tweet.
			//
			// This is the same for league_tier, which tells us how high profile
			// a specific tournament is. We'll use the same pattern for tracking that.

			_.each(this.liveGames, _.bind(function(game) {
				this.leagueStreamDelays[game.league_id] = game.stream_delay_s;
				this.leagueTier[game.league_id] = game.league_tier;
			}, this));
			this.emit("live-games:update");
		}, this));
	},

	getLeaguesWithLiveGames: function() {
		var leagueIds = _.map(this.liveGames, _.bind(function(game) {
			return game.league_id;
		}, this));


		return _.uniq(leagueIds);
	},

	getRecentLeagueMatches: function(leagueId, cb) {
		var league = this.leagues[leagueId];

		// only look for games in the last 7 days
		// (widening this window since if there aren't games in that
		//  period sometimes we miss the first game for a tournament in
		//	that window.)
		var date_min = (new Date().getTime()) - 60*60*24*7*1000;

		if(this.isDemo) {
			date_min = (new Date().getTime()) - 60*60*24*365*1000;
		}

		winston.debug("Getting most recent matches for " + league.name);
		this.api().getMatchHistory({
			league_id: leagueId,
			date_min: Math.floor(date_min/1000)
		}, _.bind(function(err, res) {
			if(err) {
				winston.error("error loading matches: " + err);
				return;
			}

			if(_.isUndefined(res)) {
				winston.error("Empty response getting recent matches for: " + league.name);
				return;
			}

			if(res.total_results == 0) {
				winston.warn("No matches returned for league_id: " + league.name);
				return;
			} else {
				// winston.info(res.matches.length + " matches found for " + league.name);
			}

			if(this.isDemo) {
				res.matches = _.first(res.matches, 2);
			}

			_.each(res.matches, _.bind(function(match) {
				this.logRecentMatch(match, this.leagues[leagueId]);
			}, this));

			this.leagues[leagueId].init = false;

			// run the callback if present.
			cb && cb(res.matches);
		}, this));
	},

	loadMatchDetails: function(matchMetadata, cb) {
		// check to see if we have a cached result for this match.
		winston.info("contents of matchDetailsCache: " + JSON.stringify(Object.keys(this.matchDetailsCache)));

		// check if we have a cached result for this match, and if we do return it.
		// also make sure the result isn't undefined - this somehow happens sometimes.
		if(matchMetadata.match_id in this.matchDetailsCache &&
			!_.isUndefined(this.matchDetailsCache[matchMetadata.match_id])) {
			// return that result.
			var match = this.matchDetailsCache[matchMetadata.match_id];

			winston.info("Loading match metadata from cache from earlier request.");
			cb && cb(match, matchMetadata);

			// drop out and avoid making the actual request.
			return;
		}

		this.api().getMatchDetails(matchMetadata.match_id, _.bind(function(err, match) {
			if(err || match.error) {
				winston.error("error loading match: " + err);
				// in this case we DON'T pull it from the queue; we want to retry
				// these. But any other type of error we want to toss it.
				if(match.error) {
					this.removeMatchFromQueue(matchMetadata);
				}
				return;
			}

			this.matchDetailsCache[matchMetadata.match_id] = match;

			cb && cb(match, matchMetadata);
		}, this));
	},

	processMatchDetails: function(matchDetails, matchMetadata, lobbyInfo) {
		// winston.info("matchDetails: " + JSON.stringify(matchDetails));
		// winston.info("matchMetadata: " + JSON.stringify(matchMetadata));

		var teams = [];
		_.each(["radiant", "dire"], function(name) {
			var team = {};
			_.each(["name", "team_id", "logo", "team_complete"], function(param) {
				team[param] = matchDetails[name+"_"+param];
			});
			team["side"] = name;

			team.kills = 0;

			teams.push(team);
		});

		// this is a little unusual; instead of counting kills and crediting the
		// to the team with the kills, we're changing to count DEATHS of the opposite
		// team and attribute that score to the opposite team. This difference matters
		// in situations with suicides and neutral denies. This matches the behavior
		// of the in-game scoreboard, even though it's sort of idiosyncratic.
		// Thanks to @datdota for pointing out this inconsistency.
		_.each(matchDetails.players, function(player) {
			var index = 1;
			if(player.player_slot >= 128) index = 0;

			teams[index].kills += player.deaths;
		});

		// Check if we have a twitter handle for this team id.
		_.each(teams, function(team) {
			if(team.team_id in team_twitter) {
				team.name = "@" + team_twitter[team.team_id];
			} else {
				winston.info("No twitter handle found for team: " + team.name + " (" + team.team_id + ")");
			}
		});

		if(matchDetails.radiant_win) {
			teams[0].winner = true;
			teams[1].winner = false;

			teams[0].displayName = "[" + teams[0].name + "]";
			teams[1].displayName = teams[1].name;
		} else {
			teams[0].winner = false;
			teams[1].winner = true;

			teams[0].displayName = teams[0].name;
			teams[1].displayName = "[" + teams[1].name + "]";
		}

		// now, lets update the series_id information.
		// first, check and see if this series has been seen before.

		// look first in the lobby info. for TI games, we won't have any
		// matchMetadata at all to work with. 
		if((lobbyInfo && lobbyInfo.lastSnapshot.series_type > 0) || matchMetadata.series_type > 0) {
			var seriesType, seriesId, usingLobbyInfo;

			if(lobbyInfo.lastSnapshot.series_type > 0) {
				seriesType = lobbyInfo.lastSnapshot.series_type;
				seriesId = null;
				usingLobbyInfo = true;
			} else {
				seriesType = matchMetadata.series_type;
				seriesId = matchMetadata.series_id;
				usingLobbyInfo = false;
			}

			winston.debug("ACTIVE SERIES: " + seriesId + " with type " + seriesType);
			winston.debug("activeSeriesIds:" + JSON.stringify(this.activeSeriesIds));

			// the logic starts to diverge here. there are two cases:
			// 1. we have matchMetadata, eg the old system of GetMatchHistory works,
			//	  and we found the match that way.
			// 2. we don't have matchMetadata and are relying on GetLiveLeagueGames-generated
			//    events to determine when a game has ended. In that case, we don't have
			//    a series_id, but we do have series_type and the aggregated radiant_series_wins
			//	  and dire_series_wins. 

			// this is the minimum structure we need. 
			// we generate more elaborate structure only if we are doing the old-fashioned
			// style.
			var seriesStatus = {"teams":{}};
			if(usingLobbyInfo) {
				seriesStatus.teams[lobbyInfo.lastSnapshot.radiant_team.team_id] = lobbyInfo.lastSnapshot.radiant_series_wins;
				seriesStatus.teams[lobbyInfo.lastSnapshot.dire_team.team_id] = lobbyInfo.lastSnapshot.dire_series_wins;
				seriesStatus.series_type = lobbyInfo.lastSnapshot.series_type;
			} else {
				// this branch is concerned with the cached version of series status only.
				if(series_id && (series_id in this.activeSeriesIds)) {
					seriesStatus = _.clone(this.activeSeriesIds[matchMetadata.series_id]);
				} else {
					seriesStatus = {
						series_id: matchMetadata.series_id,
						series_type: matchMetadata.series_type,
						teams: {},
						time: new Date().getTime()
					}

					seriesStatus.teams[teams[0]["team_id"]] = 0;
					seriesStatus.teams[teams[1]["team_id"]] = 0;
				}
			}


			// now update the results based on who won
			var teamId = teams[0]["team_id"];

			if(teams[1].winner) {
				teamId = teams[1]["team_id"];
			}

			seriesStatus.teams[teamId] = seriesStatus.teams[teamId]+1;
			seriesStatus.time = new Date().getTime();

			// construct a string where it has filled in circles for every
			// win, and empty circles to fill into the total number of games
			// necessary.

			_.each([0, 1], function(index) {
				teams[index].series_wins = seriesStatus.teams[teams[index]["team_id"]]

				var winString = "";
				for(var x=0; x<teams[index].series_wins; x++) {
					winString = winString + "\u25FC";
				}

				// at this point we have as many dots as this team has wins.
				// now, fill up the remainder.
				var gamesToWin = seriesStatus.series_type+1;
				var emptyDots = gamesToWin - teams[index].series_wins;

				// flip the direction the empty dots are on, so wins are always
				// closest to the team name.
				if(index==0) {
					for (var o=0; o<emptyDots; o++) {
						winString = "\u25FB" + winString;
					}
				} else {
					for (var o=0; o<emptyDots; o++) {
						winString = winString + "\u25FB";
					}
				}

				// store it for later.
				teams[index].wins_string = winString;
			});

			// move the information into the teams objects for convenience
			teams[0].series_wins = seriesStatus.teams[teams[0]["team_id"]]
			teams[1].series_wins = seriesStatus.teams[teams[1]["team_id"]]

			winston.debug("activeSeriesIds POST:" + JSON.stringify(this.activeSeriesIds));
		} else {
			// this branch is for non series, eg bo1.
			teams[0].series_wins = null;
			teams[1].series_wins = null;
			teams[0].wins_string = "";
			teams[1].wins_string = "";
		}

		// now push the series status into

		var durationString = " " + Math.floor(matchDetails.duration/60) + "m";

		if(matchDetails.duration%60<10) {
			durationString += "0" + matchDetails.duration%60;
		} else {
			durationString += matchDetails.duration%60;
		}

		durationString += "s";

		var league = this.leagues[matchDetails.leagueid];

		if(matchDetails.leagueid==2733) {
			league.name = "The International 2015 #ti5";
		}

		// drop the word "ticket" in all situations
		if(league.name.indexOf("Season ") > -1) {
			league.name = league.name.replace("Season ", "S");
		}

		if(league.name.indexOf("Captains Draft") > -1) {
			league.name = league.name.replace("Captains Draft", "CD");
		}

		league.name = league.name.replace(" Ticket", "");
		league.name = league.name.replace(" League", "");

		var tweetString = teams[0].wins_string + " " + teams[0].displayName + " " + teams[0].kills + "\u2014" + teams[1].kills + " " + teams[1].displayName + " " + teams[1].wins_string + "\n";
		tweetString = tweetString + durationString + " / " +league.name + "   \n";

		// check if an @ sign is the first character. If it is, then add a preceeding period
		// so it doesn't count as a reply.
		tweetString = tweetString.trim();
		if(tweetString[0]=='@') {
			tweetString = "." + tweetString;
		}

		// We know we want to append a dotabuff link, and that it will get auto-shortened
		// to a string of max length 23; (see https://dev.twitter.com/docs/api/1/get/help/configuration - this could increase)
		// so check and see if the content without the url is over the space we have left
		// for a \n + a t.co link. If it is, then chop away at the league name
		// which has started getting super long in some situations.
		// (-1 because of the \n character)

		if(tweetString.length > (140-23-1)) {
			tweetString = tweetString.substring(0, 140-23-1);
		}

		var baseString = tweetString;
		// now add the link back in.
		// this is definitely going to push the total over 140, but we count on the fact that
		// twitter will shorten it automatically for us post-submission. Not 100% sure this is true
		// but I think it is.
		tweetString = tweetString + "\nhttp://dotabuff.com/matches/" + matchMetadata.match_id;

		// we're going to prepare an extra-short tweet string too, in case
		// there's a picture to include. there are two cases here:
		// 1. the resulting tweet in tweetString has room for an extra 23 characters
		//	  for the twitter image link.
		// 2. the resulting tweet does not have room. 
		//		a. in this case, drop the dotabuff link and tweet the result, since
		//		   we know that that's the same length.

		var shortMessage;
		if(tweetString.length > 140-23-1) {
			// use the pre-dotabuff-appended link.
			shortMessage = baseString;

			// it seems like pic links are longer than normal links,
			// so cut off some extra text just in case. Not totally sure
			// about this number, can't find a reliable reference. Links
			// should be 23 max, but I've seen references to 26 chars max
			// for image links to edging on the careful side.
			if(shortMessage.length > 112) {
				shortMessage = shortMessage.substring(0, 112);
			}
		} else {
			// otherwise, we're fine; shortMessage can be the same.
			shortMessage = tweetString;
		}

		var result = {message: tweetString, teams:teams, duration:matchDetails.duration,
						seriesStatus: seriesStatus, shortMessage: shortMessage};

		return result;
	},

	isValidMatch: function(results) {
		// takes the object returned from processMatchDetails, and returns
		// true/false depending on whether it's a "real" match.
		if((results.teams[0].kills + results.teams[1].kills)==0 || results.duration <= 410) {
			return false;
		} else if(_.isUndefined(results.teams[0].name) || _.isUndefined(results.teams[1].name)) {
			return false;
		} else {
			return true;
		}
	},

	// This functionality is unsupported, it caused lots of drama.
	// DO NOT USE.
	handleFinishedMatchEarly: function(match, matchMetadata) {
		// this version of handle finished match is called as soon as we get a
		// result, so we can get a non-delayed version of the results. It does
		// some of the same things as handleFinishedMatch, but has some slightly
		// different behaviors.
		var results = this.processMatchDetails(match, matchMetadata);
		var isBlacklisted = false;
		// var isBlacklisted = _.contains(this.blacklistedLeagueIds, match.leagueid);

		if(this.isValidMatch(results) && !isBlacklisted) {
			winston.info("emailing for match: " + match.match_id);
			this.email(results.message, matchMetadata);
		}
	},

	handleFinishedMatch: function(match, matchMetadata) {
		// winston.info(JSON.stringify(match));
		// winston.info(JSON.stringify(matchMetadata));
		// okay, now lets look up the detailed lobby info.
		var lobbyInfo = this.states.getLobbyByTeamAndLeague(
			[match.radiant_team_id, match.dire_team_id], match.leagueid);

		// make the lobbyInfo available to processMatchDetails if possible. 
		try {
			var results = this.processMatchDetails(match, matchMetadata, lobbyInfo);
		} catch (e) {
			winston.info(JSON.stringify(match));
			this.removeMatchFromQueue(matchMetadata);
			winston.warn("Error processing match: " + e);
			winston.warn(new Error().stack);
			return;
		}

		// drop out, but mark this match as processed.
		if(!this.isValidMatch(results)) {
			this.removeMatchFromQueue(match);
			return;
		}

		winston.info(JSON.stringify(results));

		// In this new regime, don't tweet based on the blacklist, follow new logics:
		// 1. If it's a tier 3 league, tweet it.
		// 2. If it's a tier 1 league, blacklist it.
		// 3. Otherwise, blacklist it UNLESS it's in the WHITELIST.

		var leagueTier = matchMetadata.league_tier;

		if(leagueTier==3) {
			useAltTweet = false;
			winston.info("FOUND TIER 3 GAME - MAIN");
		} else if (leagueTier==1) {
			useAltTweet = true;
			winston.info("FOUND TIER 1 GAME - ALT");
		} else {
			// if the leagueId is in whitelisted league ids, then DON'T altTweet
			useAltTweet = !_.contains(this.whitelistedLeagueIds, match.leagueid);
			winston.info("FOUND TIER 2 GAME; USE ALT? " + useAltTweet);
		}

		// write out the match data anyway so we can manually build files if we have to
		fs.writeFileSync("games/match_" + match.match_id + ".json", JSON.stringify(results));

		if(lobbyInfo) {
			var success = boxscores.generate(lobbyInfo, results, _.bind(function(base64image) {
				// this method is called only on success. this is a little wonky for sure, but
				// that's just the way it is.


				winston.info("generation successful: (base64) " + base64image.length);
				// if boxscores fails to generate, it represents some sort of major
				// missing data like no tower data or no gold history data.
				// (over time I'll make this more tight; expect at least one gold
				// event every 2-3 minutes for the duration of the game so we can 
				// plausibly feel like we've captured the whole thing and it's worth
				// an image.

				// clean out the lobby data regardless; if we successfully generated,
				// then we don't need it anymore. If we didn't, it was sort of bad
				// data to begin with so clean it out. We'll rely on redis expiring
				// the data on bot restart.
				this.states.removeLobby(lobbyInfo.lastSnapshot.lobby_id);


				// this really should be abstracted; the logic is identical but for historical debugging
				// reasons they're separate.
				if(isSilent || isDemo) {
					winston.info("Skipping media tweet. Alt? " + useAltTweet);
				} else {
					var account = useAltTweet ? this.twitterAlt : this.twitter;
					winston.info("TWEET MEDIA: " + results.shortMessage + " (to alt? " + useAltTweet + ")");
					this._tweetMedia(account, results.shortMessage, matchMetadata, base64image);
				}
			}, this));

			if(!success) {
				// this wasn't necessarily happening otherwise.
				this.states.removeLobby(lobbyInfo.lastSnapshot.lobby_id);

				// we need to tweet normally, without an image.
				if(!useAltTweet) {
					winston.info("TWEET (generate failed): " + results.message);
					this.tweet(results.message, matchMetadata);
				} else {
					winston.info("TWEET.ALT (generate failed): " + results.message);
					this.altTweet(results.message, matchMetadata);
				}
			}
		} else {
			// we're going to decline to tweet without lobby info and see how that goes.
			winston.warn("Not tweeting because lobby info was missing: " + results.message);

			// as far as I can tell this happens largely beacuse it's a double tweet and an
			// earlier tweet attempt flushed that particular lobbyId so it's not present
			// when the second tweet attempt 

			// do non-media tweets
			if(!useAltTweet) {
				winston.info("NO TWEET (missing lobby info): " + results.message);
				// this.tweet(results.message, matchMetadata);
			} else {
				winston.info("NO TWEET.ALT (missing lobby info): " + results.message);
				// this.altTweet(results.message, matchMetadata);
			}			
		}

		// I'm not totally sure why this doesn't delay until we get an ack from
		// the twitter api. That would probably be smarter. But whatever.
		// now remove the match_id from matchIdsToTweet
		this.removeMatchFromQueue(matchMetadata);

		// update the listing if there were series wins.
		// do this late in the process in case there were errors.
		if(!_.isNull(results.teams[0].series_wins)) {
			this.activeSeriesIds[results.seriesStatus.series_id] = results.seriesStatus;
			winston.info("In handleFinishedMatch, save series status. Result: " + JSON.stringify(this.activeSeriesIds));
			// cache the series data so it survives a restart.
			this.saveSeries();
		}
		this.cleanupActiveSeries();
	},

	cleanupActiveSeries: function() {
		// run through all active series.
		var idsToRemove = [];
		var now = new Date().getTime();
		_.each(this.activeSeriesIds, function(series, id) {
			if((now - series.time) > 60*60*12*1000) {
				idsToRemove.push(series.series_id);
				winston.info("Removing series_id due to age: " + series.series_id);
			}

			var maxGames = 0;
			_.each(series.teams, function(wins, team_id) {
				maxGames = Math.max(maxGames, wins);
			});

			// series_type is 1 for a bo3, 2 for a bo5, (3 for a bo7?)
			// so just do that number +1 because that's the number of matches
			// it would take to win.
			if(maxGames==(series.series_type+1)) {
				idsToRemove.push(series.series_id);
				winston.info("Removing series_id due to max games hit " + series.series_id);
			}
		});

		_.each(idsToRemove, _.bind(function(id) {
			delete this.activeSeriesIds[id];
		}, this));

		winston.info("After cleaning, # series being tracked: " + Object.keys(this.activeSeriesIds).length);
	},

	// should really abstract this properly but I'm lazy right now and
	// don't want to deal with the throttle function and arguments.
	_altTweet: function(string, match) {
		if(this.isDemo || this.isSilent) {
			this.removeMatchFromQueue(match);
			return;
		}

		this.twitterAlt.post('statuses/update', { status: string }, _.bind(function(err, reply) {
			if (err) {
					winston.error("Error posting tweet: " + err);

					if(err.message.indexOf('duplicate')!=-1 || err.message.indexOf('update limit')!=-1) {
						winston.info("Error posting, duplicate or over limit - drop.");
						this.removeMatchFromQueue(match);
					}
			} else {
					winston.debug("Twitter reply: " + reply + " (err: " + err + ")");
			}
		}, this));
	},

	_tweet: function(string, match) {
		if(this.isDemo || this.isSilent) {
			this.removeMatchFromQueue(match);
			return;
		}

		this.twitter.post('statuses/update', { status: string }, _.bind(function(err, reply) {
				if (err) {
	  				winston.error("Error posting tweet: " + err);

	  				if(err.message.indexOf('duplicate')!=-1 || err.message.indexOf('update limit')!=-1) {
	  					winston.info("Error posting, duplicate or over limit - drop.");
	  					this.removeMatchFromQueue(match);
	  				}
				} else {
	  				winston.debug("Twitter reply: " + reply + " (err: " + err + ")");
				}
  		}, this));
	},

	_tweetMedia: function(t, string, match, base64image) {
		if(this.isDemo || this.isSilent) {
			this.removeMatchFromQueue(match);
			return;
		}

		// winston.info("loading file: " + filename);
		// var content = fs.readFileSync(filename);
		// winston.info("loaded content, length: " + content.length);

		var b64content = base64image;
		winston.info("b64 content length: " + b64content.length);
		t.post('media/upload',
			{media: b64content},
			_.bind(function (err, data, response) {
				winston.info("media upload callback firing");
				winston.info("response: " + response);
				winston.info("err: " + err);
				if(err) {
					winston.info("Falling back to text tweet.");

					// winston.error(err);
					// winston.error(response);
					if(t==this.twitter) {
						this.tweet(string, match);						
					} else {
						this.altTweet(string, match);
					}

				} else {
					winston.info("Uploaded media: " + mediaIdStr);

					var mediaIdStr = data.media_id_string;
					var params = { status: string, media_ids: [mediaIdStr] };

					t.post('statuses/update', params,
						_.bind(function(err, data, response) {
							if(err) {
								if(err.message.indexOf('duplicate')!=-1 || err.message.indexOf('update limit')!=-1) {
				  					winston.info("Error posting, duplicate or over limit - drop.");
				  					this.removeMatchFromQueue(match);
	  							}
							} else {
								winston.info("Posted media tweet successfully: " + response);
							}
						}, this));
				}
			}, this));
	},

	email: function(string, match) {
		if(_.isNull(mc)) {
			winston.error("No mandrill client initialized, rejecting email.");
			return;
		}

		if(this.subscribers.length==0) {
			winston.error("No subscribers specified, rejecting email.");
			return;
		}

		var to = _.map(this.subscribers, function(sub) {
			return {email: sub};
		});

		// send the actual email.
		var message = {
			"text": string,
			"to": to,
			"subject": string.split("\n")[0],
			"preserve_recipient": false,
			"track_clicks": false,
			"from_email": "drew.harry@gmail.com",
			"from_name": "Dota 2 Results"
		};

		mc.messages.send({message:message}, function(result) {
			winston.info("Email sent, result: " + JSON.stringify(result));
		},
		function(e) {
			winston.warning("Error sending email: " + e.name + ": " + e.message);
		});
	},

	removeMatchFromQueue: function(match) {
		winston.info("Removing match id after completed or declined tweet: " + match.match_id);

		// winston.info("matches before: " + JSON.stringify(this.matchesToTweet));
		this.matchesToTweet = _.reject(this.matchesToTweet, function(m) {
			return m.match_id==match.match_id;
		});
		// winston.info("matches after: " + JSON.stringify(this.matchesToTweet));

		// remove the details cache too to keep it from accumulating.
		delete this.matchDetailsCache[match.match_id];

		// Make sure it's not in redis either. 99% of the time it won't be, but
		// we'll just make absolute sure here. It's a cheap operation and it fails
		// easily.
		if(this.redis) {
			winston.debug("Trying to remove " + match.match_id + " from delayed_matches.")
			this.redis.hdel("global:delayed_matches", match.match_id,
				function(err, reply) {
					if(err) {
						winston.warn("\tError removing match: " + err);
					}
					winston.info("\tRemoved " + reply + " matches.");
				});
		} else {
			winston.warn("No redis instance to remove match from.");
		}
	},

	api: function() {
		return new dazzle(process.env.STEAM_API_KEY);
	}
};

_.extend(exports.ResultsServer.prototype, EventEmitter.prototype);



/////////////////////////////////////////////////////
//					STARTUP 					   //
/////////////////////////////////////////////////////

var server = new exports.ResultsServer();

// this is really super duper fragile
var isDemo = process.argv[2]=="demo";
var isSilent = process.argv[2]=="silent";


winston.info("demo: " + isDemo);
winston.info("silent: " + isSilent);

server.init(isDemo, isSilent);
server.start();


process.on('uncaughtException', function(err) {
  winston.error(err.stack);
});
