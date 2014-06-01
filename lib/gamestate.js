var winston = require('winston'),
	_ = require('underscore')._;

function GameStateTracker(redis) {
	this.lobbies = {};
	this.redis = redis;
}

// the primary internal data structure here is the lobbies object
// it maps lobbyId keys to an object that contains a few pieces
// of info:
//	- lastTimestamp
//	- lastSnapshot
//	- goldHistory: list of {timestamp, radiantGold, direGold, diff} objects
//	- events: list of {event_type, timestamp, team, ...} (include other random metadata)
//	- 

GameStateTracker.prototype = {
	lobbies: null,

	processSnapshot: function(lobbyId, snapshot) {
		var lobby;

		if(lobbyId in this.lobbies) {
			lobby = this.lobbies[lobbyId];
			winston.debug("Found existing lobby for " + lobbyId);

			// check about the time gap between snapshots
			// there's potentially an issue when there's a big gap
			if((snapshot.scoreboard.duration - lobby.lastTimestamp) > 60) {
				winston.warn("More than 60 seconds gap in snapshots for " + lobbyId);				
			}
			lobby.goldHistory.push(this.handleGold(lobby, snapshot));

			_.each(this.handleEvents(lobby, snapshot), _.bind(function(event) {
				lobby.events.push(event);
			}, this));

			lobby.lastSnapshot = snapshot;
			lobby.lastTimestamp = snapshot.scoreboard.duration;
		} else {
			lobby = {
				lastTimestamp: snapshot.scoreboard.duration,
				lastSnapshot: snapshot,
				goldHistory: [],
				events: []
			};

			winston.info("Creating a new lobby entry for an unseen lobby.");
		}
	},

	// returns a list of new events.
	handleEvents: function(lobby, snapshot) {

		return [];
	},

	// generates a single object that represents a gold snapshot
	handleGold: function(lobby, snapshot) {
		return {radiantGold: 500, direGold: 1200, diff: 700};
	},
};

// export the primary object
module.exports = GameStateTracker;