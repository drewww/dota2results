var request = require('request'),
	winston = require('winston'),
	_ = require('underscore')._,
	dazzle = require('dazzle'),
	fs = require('fs');

var api = new dazzle(process.env.STEAM_API_KEY);

var maxTeamId = 0;

var allTeams = [];

var stop = false;

var interval;


function getTeamsStartingAtId() {
	api.getTeamInfoByTeamID({start_at_team_id:maxTeamId}, function(err, res) {
		var teams = res.teams;

		if(err || teams.length==0) {
			winston.info("FINISHED: " + err + " teams.length=" + teams.length);
			return;
		}

		winston.info(maxTeamId + "    found: " + teams.length);

		var teamsString = "";
		_.each(teams, function(team) {
			if(team.team_id > maxTeamId) {
				maxTeamId = team.team_id;
			}

			teamsString = teamsString + team.team_id + "\t\t" + team.tag + "\t\t" + team.name + "\n";
		});

		save(teamsString, maxTeamId);

		setTimeout(getTeamsStartingAtId, 10);
	});	
}

function save(teamsString, maxTeamId) {
	fs.appendFile('teams.txt', teamsString);
	fs.writeFile('max_team_id', maxTeamId);
}

// function loadJSON() {
// 	json = fs.readFileSync('all_teams.json', {encoding:"utf-8"});
// 	allTeams = JSON.parse(json);
// 	winston.info("team count: " + allTeams.length);

// 	_.each(allTeams, function(team) {
// 		if(team.team_id > maxTeamId) {
// 			maxTeamId = team.team_id;
// 		}
// 	});
// 	winston.info("max team id: " + maxTeamId);
// }

try {
	maxTeamId = parseInt(fs.readFileSync('max_team_id', {encoding: 'utf-8'}));
} catch (e){
	winston.info("err loading: " + e);
}

getTeamsStartingAtId();