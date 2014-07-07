var winston = require('winston'),
	boxscores = require('./boxscores.js'),
	fs = require('fs'),
	_ = require('underscore')._;

function GameStateTracker(redis) {
	this.lobbies = {};
	this.redis = redis;
	this.lobbiesThisTick = [];

	// load lobbies out of redis
	// we could just shove it all into one key, but that's
	// a little gross. Lets be a little more civilized and do it per key.
	this.redis.keys("lobby:*", _.bind(function(err, reply) {
		_.each(reply, _.bind(function(key) {
			this.redis.get(key, _.bind(function(err, reply) {
				// load it in.
				var lobbyId = key.split(":")[1];
				this.lobbies[lobbyId] = JSON.parse(reply);
				winston.info("loading in: " + lobbyId + " goldTicks: " + this.lobbies[lobbyId].goldHistory.length + " events: " + this.lobbies[lobbyId].events.length);
			}, this));
		}, this));
		winston.info("Done loading, found " + reply.length + " lobby entries.");
	}, this));

	winston.info("Constructed game state tracker.");
}

// the primary internal data structure here is the lobbies object
// it maps lobbyId keys to an object that contains a few pieces
// of info:
//	- lastTimestamp
//	- lastSnapshot
//	- goldHistory: list of {timestamp, radiantGold, direGold, diff} objects
//	- events: list of {event_type, timestamp, team, ...} (include other random metadata)

GameStateTracker.prototype = {
	lobbies: null,

	lobbiesThisTick: null,

	processSnapshot: function(snapshot) {

		var lobby;
		var lobbyId = snapshot.lobby_id;

		this.lobbiesThisTick.push(lobbyId);

		if(lobbyId in this.lobbies) {
			lobby = this.lobbies[lobbyId];
			// winston.debug("Found existing lobby for " + lobbyId);

			// check about the time gap between snapshots
			// there's potentially an issue when there's a big gap
			if((snapshot.scoreboard.duration - lobby.lastTimestamp) > 60) {
				// winston.debug("More than 60 seconds gap in snapshots for " + lobbyId);				
			}

			if(snapshot.scoreboard.duration==lobby.lastTimestamp) {
				// winston.debug("Duplicate snapshot detected in lobby " + lobbyId + " for time " + lobby.lastTimestamp);

				// just skip it, nbd.
				// since snapshots seem to only update every 1-2 minutes,
				// this is going to happen a lot.
				return;
			}

			if(lobby.lastTimestamp==0) {
				// implicitly, the last check would have caught another 0. 
				// so if last was 0 and we're here, this is the first non-zero
				// tick for a game. 
				winston.info("Game started for real: " + lobbyId);
			}

			// winston.info("processing new snapshot for " + lobbyId);

			// extract new gold data from this snapshot
			lobby.goldHistory.push(this.handleGold(lobby, snapshot));

			// extract events (this is just tower kills right now)
			_.each(this.handleEvents(lobby, snapshot), _.bind(function(event) {
				lobby.events.push(event);
			}, this));

			// do some accounting
			lobby.lastSnapshot = snapshot;
			lobby.lastTimestamp = snapshot.scoreboard.duration;
			lobby.lastUpdate = Date.now();

			// we may not need these but storing for now.
		} else {
			if(_.isUndefined(snapshot.scoreboard)) {
				winston.warn("Found undefined scoreboard for lobby " + lobbyId);
				return;
			}

			lobby = {
				lastTimestamp: snapshot.scoreboard.duration,
				lastSnapshot: snapshot,
				goldHistory: [],
				events: [],
				finished: false
			};

			winston.info("Creating a new lobby entry for an unseen lobby.");
		}

		this.lobbies[lobbyId] = lobby;
		// cache it to redis
		this.redis.set("lobby:" + lobbyId, JSON.stringify(lobby));

		// let these keys expire 60 minutes after their last update.
		// this will keep things from getting too out of hand. 
		this.redis.expire("lobby:" + lobbyId, 60*60);
	},

	finish: function() {
		// look for lobbyIds that we didn't see updates for in this last cycle.
		// those are probably games that have ended.

		var lobbiesTracked = Object.keys(this.lobbies);
		winston.debug("tracked: " + lobbiesTracked.length + " (this tick " + this.lobbiesThisTick.length + ")");

		// start with the list of all lobbies tracked. Remove any
		// lobby we saw this tick. The remaining ids are lobbies
		// that have probably closed.

		// filter out finished lobbies
		var lobbiesMissed = _.filter(lobbiesTracked, _.bind(function(lobby) {
			return !(this.lobbies[lobby].finished);
		}, this));

		_.each(this.lobbiesThisTick, function(lobbyId) {
			// winston.info("lobbyId: " + JSON.stringify(lobbyId) + " in " + JSON.stringify(lobbiesMissed));
			lobbiesMissed = _.without(lobbiesMissed, lobbyId + "");
		});

		this.lobbiesThisTick = [];


		if(lobbiesMissed.length > 0) {
			// winston.info("MISSED LOBBY IDS: " + JSON.stringify(lobbiesMissed));
			_.each(lobbiesMissed, _.bind(function(lobbyId) {
				// extract some summary info
				// we want to know:
				//	which teams are playing
				//	which league
				//	which heroes
				var finishedGameLobby = this.lobbies[lobbyId];

				var teams = {};
				_.each(["radiant", "dire"], function(team) {
					var info = finishedGameLobby.lastSnapshot[team + "_team"];

					if(_.isUndefined(info)) {
						// not sure why this is happening.
						// I don't think this is totally game-breaking; i'm not even sure
						// we use this information at all, since detecting finished matches
						// is sort of not-critical at this point.
						winston.info("found undefined info for " + team + " in lobby " + lobbyId);
						return;
					}

					// now add in hero info
					var players = finishedGameLobby.lastSnapshot.scoreboard[team].players;
					var heroes = [];
					_.each(players, function(player) {
						heroes.push(player.hero_id);
					});
					info.heroes = heroes;
					teams[team] = info;
				});

				finishedGameLobby.teams = teams;
				finishedGameLobby.lobby_id = lobbyId;

				winston.info("GAME OVER: " + JSON.stringify(teams));
				// at this point we mark the lobby as a game over lobby
				// and hold onto it.
				finishedGameLobby.finished = true;

				this.lobbies[lobbyId] = finishedGameLobby;
				// fs.writeFileSync("games/lobby_" + lobbyId + ".json", JSON.stringify(finishedGameLobby));
				// boxscores.generate(finishedGameLobby);

				// stop deleting game states for now. we only want to delete
				// after we've done a generate operation, which we need to 
				// delay until we get the actual game info.
				// winston.info("Deleting: " + lobbyId);
				// delete this.lobbies[lobbyId];
			}, this));
		}
	},

	// returns a list of new events.
	handleEvents: function(lobby, snapshot) {
		// we're looking for changes in:
		//	tower state
		//	kills (eh, skip this for now)
		//	roshan (eventually; might be challenging to detect in 60s increments)
		//  ?? items?

		if(lobby.lastSnapshot.tower_state != snapshot.tower_state) {
			// winston.debug("Detected a tower state change: " + lobby.lastSnapshot.tower_state + " -> " + 
			//	 snapshot.tower_state);

			// this is the way the bits are used for tower state. I think left-most
			// edge of this is the MSB, so if I shift these off one at a time
			// I'll basically move from the bottom of this list to the top.
			// 
		    // ┌─┬─┬─┬─┬─┬─┬─┬─┬─┬───────────────────────────────────────────── Not used.
		    // │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────────────────────── Dire Ancient Top
		    // │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────────────────────── Dire Ancient Bottom
		    // │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────────────────── Dire Bottom Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────────────────── Dire Bottom Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────────────── Dire Bottom Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────────────── Dire Middle Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────────── Dire Middle Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────────── Dire Middle Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────────── Dire Top Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────────── Dire Top Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────────── Dire Top Tier 1 
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────────── Radiant Ancient Top
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────────── Radiant Ancient Bottom
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────────── Radiant Bottom Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────────── Radiant Bottom Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────────── Radiant Bottom Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────────── Radiant Middle Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───────── Radiant Middle Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─────── Radiant Middle Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌───── Radiant Top Tier 3
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─── Radiant Top Tier 2
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ ┌─ Radiant Top Tier 1
		    // │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │
		    // 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0

		    var towerTypes = [
		    	{team:"radiant", tier: 1, lane: "top", mask: Math.pow(2, 0)},
		    	{team:"radiant", tier: 2, lane: "top", mask: Math.pow(2, 1)},
		    	{team:"radiant", tier: 3, lane: "top", mask: Math.pow(2, 2)},
		    	{team:"radiant", tier: 1, lane: "mid", mask: Math.pow(2, 3)},
		    	{team:"radiant", tier: 2, lane: "mid", mask: Math.pow(2, 4)},
		    	{team:"radiant", tier: 3, lane: "mid", mask: Math.pow(2, 5)},
		    	{team:"radiant", tier: 1, lane: "bot", mask: Math.pow(2, 6)},
		    	{team:"radiant", tier: 2, lane: "bot", mask: Math.pow(2, 7)},
		    	{team:"radiant", tier: 3, lane: "bot", mask: Math.pow(2, 8)},
		    	{team:"radiant", tier: 4, lane: "bot", mask: Math.pow(2, 9)},
		    	{team:"radiant", tier: 4, lane: "top", mask: Math.pow(2, 10)},
		    	{team:"dire", tier: 1, lane: "top", mask: Math.pow(2, 11)},
		    	{team:"dire", tier: 2, lane: "top", mask: Math.pow(2, 12)},
		    	{team:"dire", tier: 3, lane: "top", mask: Math.pow(2, 13)},
		    	{team:"dire", tier: 1, lane: "mid", mask: Math.pow(2, 14)},
		    	{team:"dire", tier: 2, lane: "mid", mask: Math.pow(2, 15)},
		    	{team:"dire", tier: 3, lane: "mid", mask: Math.pow(2, 16)},
		    	{team:"dire", tier: 1, lane: "bot", mask: Math.pow(2, 17)},
		    	{team:"dire", tier: 2, lane: "bot", mask: Math.pow(2, 18)},
		    	{team:"dire", tier: 3, lane: "bot", mask: Math.pow(2, 19)},
		    	{team:"dire", tier: 4, lane: "bot", mask: Math.pow(2, 20)},
		    	{team:"dire", tier: 4, lane: "top", mask: Math.pow(2, 21)}
		    ];

		    // first, get just the bits that have changed, eg
		    //	0011010	- previous
		    //	0010010	- now
		    //		XOR
		    //	0001000 - only bits that are either in one or the other.
		    //			  technically this would turn up towers that went
		    //			  from 0 to 1, but that can't happen game-wise.

		    var towersChanged = lobby.lastSnapshot.tower_state ^ snapshot.tower_state;

		    // loop through all potential towers.
		    // try masking each one.
		    var events = [];
		    _.each(towerTypes, function(tower) {
		    	if(towersChanged & tower.mask) {
		    		var e = _.clone(tower);
		    		e.time = snapshot.scoreboard.duration;
		    		events.push(e);

		    		// winston.info("TOWER FELL: " + JSON.stringify(e));
		    	}
		    });

		    return events;
		} else {
			// no tower change events detected.
			return [];
		}
	},

	// generates a single object that represents a gold snapshot
	handleGold: function(lobby, snapshot) {

		// first pass at this:
		// 	look at every player, multiply their GPM rate by the
		//	current timestamp to get the gold values.
		var gold = {};
		_.each(["radiant", "dire"], function(team) {
			var players = snapshot.scoreboard[team].players;

			var sumGold = 0;
			_.each(players, function(player) {
				sumGold+= player.net_worth;
			});

			gold[team] = sumGold;
		});

		return {time: snapshot.scoreboard.duration,
				radiantGold: gold.radiant,
				direGold: gold.dire,
				diff: (gold.radiant - gold.dire)};
	},

	// annoyingly, there's no clear way to link lobby ids back to game ids.
	// when the lobby closes we're missing critical info:
	// 	- who won?
	//	- what was the series status?
	//	- what is the game id for confirming against dotabuff or getting replays
	//	  or whatever else we might want?
	// there's also a timing issue here; I thiiiiink we get the GAME OVER event
	// before the MatchDeatails strategy updates, but we need to decouple these
	// events and link them up based on whoever comes second.
	getLobbyByTeamAndLeague: function(teams, leagueId) {
		winston.info("Looking up lobby by team + league: " + JSON.stringify(teams) + " in " + leagueId);
		var lobby = _.find(this.lobbies, function(lobby) {
			if(leagueId==lobby.lastSnapshot.league_id) {
				// now look at teams
				// sometimes lobby.teams is undefined. I have no idea why,
				// but it seems like lastSnapshot.dire_team and .radiant_team
				// should work. So, we'll work with that instead.
				var radiantTeamId;
				var direTeamId;

				// make sure everything we need is defined. If any of it isn't, fall back to
				// information from the last snapshot.
				try {
					if(_.isUndefined(lobby.teams) ||
						_.isUndefined(lobby.teams.radiant) ||
						_.isUndefined(lobby.teams.dire)) {
						winston.info("\tno teams, fallback to snapshot");

						radiantTeamId = lobby.lastSnapshot.radiant_team.team_id;
						direTeamId = lobby.lastSnapshot.dire_team.team_id;
					} else {
						radiantTeamId = lobby.teams.radiant.team_id;
						direTeamId = lobby.teams.dire.team_id;					
					}
				} catch (e) {
					winston.error("Exception extracting team ids! " + e);
					return false;
				}

				if(_.contains(teams, radiantTeamId) && _.contains(teams, direTeamId)) {
					winston.info("found!");
					return true;
				}
			}
			return false;
		});


		var lobbiesToDelete = _.filter(this.lobbies, function(lobby) {
			return (Date.now() - lobby.lastUpdate) > (1000*60*60*3);
		});

		_.each(lobbiesToDelete, _.bind(function(lobbyId) {
			winston.info("removing lobby due to age " + lobbyId);
			this.removeLobby(lobbyId);
		}, this));

		// not actually going to return a different value here since 
		if(_.isUndefined(lobby)) {
			winston.warn("Did not found any lobby matching " + JSON.stringify(teams) + " in league " + leagueId);
		}

		return lobby;
	},

	removeLobby: function(lobbyId) {
		delete this.lobbies[lobbyId];
		this.redis.del("lobby:" + lobbyId);
	}
};

// export the primary object
module.exports = GameStateTracker;