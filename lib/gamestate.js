var winston = require('winston'),
	_ = require('underscore')._;

function GameStateTracker(redis) {
	this.lobbies = {};
	this.redis = redis;
	this.lobbiesThisTick = [];

	winston.info("Constructed game state tracker.");
}

// the primary internal data structure here is the lobbies object
// it maps lobbyId keys to an object that contains a few pieces
// of info:
//	- lastTimestamp
//	- lastSnapshot
//	- goldHistory: list of {timestamp, radiantGold, direGold, diff} objects
//	- events: list of {event_type, timestamp, team, ...} (include other random metadata)
//	- allSnapshots: []

GameStateTracker.prototype = {
	lobbies: null,

	lobbiesThisTick: null,

	processSnapshot: function(snapshot) {

		var lobby;
		var lobbyId = snapshot.lobby_id;

		winston.info("Pocessing snapshot for " + lobbyId);
		// winston.info(JSON.stringify(snapshot));

		this.lobbiesThisTick.push(lobbyId);

		if(lobbyId in this.lobbies) {
			lobby = this.lobbies[lobbyId];
			winston.debug("Found existing lobby for " + lobbyId);

			// check about the time gap between snapshots
			// there's potentially an issue when there's a big gap
			if((snapshot.scoreboard.duration - lobby.lastTimestamp) > 60) {
				winston.warn("More than 60 seconds gap in snapshots for " + lobbyId);				
			}

			if(snapshot.scoreboard.duration==lobby.lastTimestamp) {
				winston.warn("Duplicate snapshot detected in lobby " + lobbyId + " for time " + lobby.lastTimestamp);

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

			lobby.goldHistory.push(this.handleGold(lobby, snapshot));

			winston.info("gold: " + JSON.stringify(lobby.goldHistory));

			_.each(this.handleEvents(lobby, snapshot), _.bind(function(event) {
				lobby.events.push(event);
			}, this));

			lobby.lastSnapshot = snapshot;
			lobby.lastTimestamp = snapshot.scoreboard.duration;

			lobby.allSnapshots.push(snapshot);
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
				allSnapshots: []
			};

			winston.info("Creating a new lobby entry for an unseen lobby.");
		}

		this.lobbies[lobbyId] = lobby;
	},

	finish: function() {
		// look for lobbyIds that we didn't see updates for in this last cycle.
		// those are probably games that have ended.

		var lobbiesTracked = Object.keys(this.lobbies);
		winston.info("tracked: " + JSON.stringify(lobbiesTracked));

		var lobbiesMissed = _.reject(lobbiesTracked, _.bind(function(lobbyId) {
			return ! (parseInt(lobbyId) in this.lobbiesThisTick);
		}, this));

		winston.info("MISSED LOBBY IDS: " + JSON.stringify(lobbiesMissed));
		_.each(lobbiesMissed, _.bind(function(lobbyId) {
			// Eventually we will do something dramatic here. This is when we'll
			// kick off processing for the image.

			winston.info("Deleting: " + lobbyId);
			delete this.lobbies[lobbyId];
		}, this));
	},

	// returns a list of new events.
	handleEvents: function(lobby, snapshot) {
		return [];
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
				sumGold+= Math.floor(player.gold_per_min * (snapshot.scoreboard.duration/60.0));
			});

			gold[team] = sumGold;
		});

		return {time: snapshot.scoreboard.duration,
				radiantGold: gold.radiant,
				direGold: gold.dire,
				diff: (gold.radiant - gold.dire)};
	},
};

// export the primary object
module.exports = GameStateTracker;