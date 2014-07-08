var Canvas = require('canvas'),
	_ = require('underscore')._,
	Image = Canvas.Image;

var	fs = require('fs'),
	winston = require('winston');


function saveCanvas(canvas, filename, cb) {
	winston.info("Writing out completed canvas to " + filename);

	var out = fs.createWriteStream("/tmp/" + filename + '.png');
	var stream = canvas.pngStream();

	stream.on('data', function(chunk){
	  out.write(chunk);
	});

	stream.on('end', function(){
	  winston.info('saved png: ' + filename + ".png");

	  cb && cb(filename + ".png");
	});

	return;
}

function drawImageForHeroId(heroId, dx, dy, ctx) {
	// the 'heroes' object contains all we need for this. It's a list of hero
	// objects with their heroIds and their x/y positions within the minimap 
	// sheet. 

	var hero = _.find(heroes, function(hero) {
		return hero.id == heroId;
	});

	if(_.isUndefined(hero)) {
		return;
	}

	ctx.drawImage(heroSpriteSheet, hero.x, hero.y, 32, 32, dx, dy, 24, 24);
}

module.exports.drawImageForHeroId = drawImageForHeroId;
module.exports.saveCanvas = saveCanvas;