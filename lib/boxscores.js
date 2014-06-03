var Canvas = require('canvas'),
	_ = require('underscore')._,
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

	// render the gold graph
	ctx.save();

	// translate into a coordinate system where 0 is 0, and halfway down the chart.
	ctx.translate(5, 100);

	// draw a center line
	ctx.strokeStyle = "#707070";
	ctx.moveTo(0, 0);
	ctx.lineTo(400-10, 0);
	ctx.stroke();

	// relevant scaling info
	// we're scaling our x axis to be 0->60 minutes
	// eventually we'll be flexible above 60, but for now just do a fixed
	// scaling. This means 0 time to 3600 seconds, over 390 pixels.
	// so, pixels per second
	var timeScaling = 390.0/3600.0;

	// eventually this will be a log scale, but for now we'll do linear.
	// we want the graph to be about 100 pixels high and support a domain
	// of -20k -> +20k. so, pixels per gold diff. +/-, so do half.
	var goldScaling = 50.0/20000.0;
	ctx.moveTo(0, 0);
	ctx.strokeStyle = "#fff";
	_.each(game.goldHistory, function(snapshot) {
		ctx.lineTo(snapshot.time*timeScaling, snapshot.diff*goldScaling);
	});
	ctx.stroke();

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