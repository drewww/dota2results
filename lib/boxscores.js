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
	// fs.writeFile("games/" + game.lobby_id + ".json", JSON.stringify(game));

	// ACTUAL RENDER LOGIC STARTS HERE
	ctx.fillStyle = "#132427";
	ctx.fillRect(0, 0, 400, 200);


	// render the header and footer team names
	ctx.font = "bold 20px Helvetica";
	ctx.fillStyle = "#fff";
	ctx.fillText(game.teams.radiant.team_name, 10, 25);
	ctx.fillText(game.teams.dire.team_name, 10, 200-0-10);

	// RENDER ENDS

	saveCanvas(canvas, game.lobby_id);
}

function saveCanvas(canvas, filename) {
	var out = fs.createWriteStream("images/" + filename + '.png');
	var stream = canvas.pngStream();

	stream.on('data', function(chunk){
	  out.write(chunk);
	});

	stream.on('end', function(){
	  winston.info('saved png: ' + filename + ".png");
	});

	return;
}

module.exports.generate = generate;