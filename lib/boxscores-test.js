var winston = require('winston'),
	boxscores = require('./boxscores.js'),
	_ = require('underscore')._,
	fs = require('fs');

winston.cli();

// simple wrapper script for testing image generation in a 
// direct way rather than waiting for a game to end with
// live data. takes a filename, loads it, and calls 
// generate on the resulting JSON.

// 1 is node, 2 is the script name, 3 is the filename
if(process.argv.length>=3) {
	var filenames = process.argv.slice(2);

	_.each(filenames, function(filename) {
		var file = fs.readFileSync(filename);
		try {
			var gameJSON = JSON.parse(file);

			boxscores.generate(gameJSON.game, gameJSON.metadata);
		} catch (e) {
			winston.error("Error loading or generating image: " + e);
		}
	});
} else {
	winston.error("Requires a parameter!");
}

