var Canvas = require('canvas');

var	fs = require('fs'),
	winston = require('winston');

// this library is stateless. Given a final game snapshot,
// generates an image that represents that information
// concisely.

function generate(game) {
	winston.info("generating image for lobby: " + game.lobby_id);
	// for now, just cache the games locally.
	fs.writeFile("games/" + game.lobby_id + ".json", JSON.stringify(game));
	return;
}

module.exports.generate = generate;