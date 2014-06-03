var Canvas = require('canvas'),
	Image = Canvas.Image;

var	fs = require('fs'),
	winston = require('winston');

// this library is stateless. Given a final game snapshot,
// generates an image that represents that information
// concisely.

function generate(game) {
	canvas = new Canvas(400,200)
	ctx = canvas.getContext('2d');

	winston.info("generating image for lobby: " + game.lobby_id);
	// for now, just cache the games locally.
	fs.writeFile("games/" + game.lobby_id + ".json", JSON.stringify(game));

	saveCanvas(canvas, game.lobby_id);
}

function saveCanvas(canvas, filename) {
	var out = fs.createWriteStream("games/" + filename + '.png');
	var stream = canvas.pngStream();

	stream.on('data', function(chunk){
	  out.write(chunk);
	});

	stream.on('end', function(){
	  console.log('saved png: ' + filename + ".png");
	});

	return;
}

module.exports.generate = generate;