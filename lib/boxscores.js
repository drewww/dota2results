var Canvas = require('canvas'),
	_ = require('underscore')._,
	Image = Canvas.Image;

var	fs = require('fs'),
	winston = require('winston');

// this library is stateless. Given a final game snapshot,
// generates an image that represents that information
// concisely.

// NOTE: we're going to need to delay this call until later in the
// process when we have the matchDetails information to join
// with the game history information. Otherwise, we don't have
// a way to get at series status info or ultimate winner.
//
// I'll come back to this issue later, though; we can get most
// of the viz built without that info and will work out the two
// tiered problem that is matching mainline scraper results
// with the accumulated game state results. I don't expect that
// to be THAT hard, but it is going to involve searching through
// recently recorded game results and look for the same two teams
// playing in the same tournament. 
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
	ctx.lineTo(345, 0);
	ctx.stroke();

	// relevant scaling info
	// we're scaling our x axis to be 0->60 minutes
	// eventually we'll be flexible above 60, but for now just do a fixed
	// scaling. This means 0 time to 3600 seconds, over 340 pixels.
	// that right edge is 5 pixe margin - 50 pixels for kill info
	// so, pixels per second
	var timeScaling = 345.0/3600.0;

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
	ctx.restore();
	
	// render the end game kill information on the right side.
	ctx.translate(355, 50);

	// first, the k.
	ctx.font = "bold 14px Helvetica";
	ctx.fillText("K", 12, 5);

	// now do radiant then dire
	var y = 40;
	ctx.font = "bold 32px Helvetica";
	_.each(["radiant", "dire"], function(team) {
		// decide if this team won or lost, and pick colors
		// appropriately.

		var kills = game.lastSnapshot.scoreboard[team].score;
		ctx.fillText(kills, 0, y);

		y += 40;
	});

	ctx.restore();
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