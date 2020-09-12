var fs = require('fs');
var csv = require('csv');
var parse_sync = require('csv-parse/lib/sync');

var verbose = false;

var SRU_koder = [];

var slask = [];

var debug;

debug = function debug() {
    verbose && console.log.apply(this, arguments);
}

function parseSRU_Rule(rule) {

    var include = [];
    var exclude = [];
    var matchsign;

    debug("parse SRU rule: ", rule);

    rule = rule.trim();

    if(rule.startsWith("+ ")) {
	matchsign = 1;
	rule = rule.substring(2);
    } else if(rule.startsWith("- ") || rule.startsWith('– ')) {
	matchsign = -1;
	rule = rule.substring(2);
    } else {
	matchsign = 0;
    }

//    console.log("process include, exclude for: " + rule);

// 249x exkl. 2492, 26xx-27xx, 28xx exkl. 286x-287x -> [ "249x exkl. 2492", "249x exkl. 2492", "249x exkl. 2492" ]
// 49xx exkl. (4910-4931, 496x, 498x) -> ["49xx exkl. (4910-4931, 496x, 498x)" ]

// not supported
// 49xx exkl. (4910-4931, 496x, 498x), 89xx, 75xx -> ["49xx exkl. (4910-4931, 496x, 498x)", "89xx", "75xx" ]


    var parts = [];

    var items = rule.split(/[()]/);

    if(items.length > 1) {
	// split multi excl rule within parenthesis exkl. (NNxx-MMxx,NNNx, ...)

	if(items.length > 3 || items[2].length > 0) {
	    console.error("Unhandled rule syntax: " + rule);
	    process.exit(1);
	}
	// [ '49xx exkl. ', '4910-4931, 496x, 498x', '' ]

	parts = [ items.join(" ").trim() ];

    } else {
	parts = items[0].split(",");
    }

    debug("iterate parts: ", parts);

    parts.forEach((part) => {
	part = part.trim().split("exkl.");

	debug("expand split part: ", part);

	function expand(p) {
	    var res = [];

	    debug("expand part: ", p);

	    p = p.trim();
	    p = p.split(/[-–]/);

	    debug("expand array: ", p);

	    if(p.length > 1) {
		var from = 1*p[0].match(/\d+/);
		var to   = 1*p[1].match(/\d+/);

		debug("iterate from: ", from, " to ", to);

		for(i = from; i <= to; i++) {
		    res.push(((""+i+"xxxx").slice(0,4)).replace(/x/g, "\\d"));
		}
	    } else {
		res.push(p[0].replace(/x/g, "\\d"));
	    }
	    return res;
	}

	include = include.concat(expand(part[0]));
	if(part[1]) {
	    debug("exclude part: ", part);
	    exclude = exclude.concat(expand(part[1]));
	}
    });

    debug("include:" + include.join(","));
    debug("exclude:" + exclude.join(","));

    return {
	rule: rule,
	matchsign: matchsign,
//	include: include,
//	exclude: exclude

	include: include.length ? new RegExp(include.join("|")) : false,
	exclude: exclude.length ? new RegExp(exclude.join("|")) : false
    };
}


function parseCSV(filename, cb) {

    console.log("parsing filename: " + filename);

    var parser = csv.parse(); //{columns: true});


    var queue = [];
    var current = false;

    endOfFile = false;

    var header = false;
    var index = 0;

    function addRecord(record) {
	//console.log("adding SRU codes: ", record);

	if(record[0].match(/^7\d\d\d$/)) {
	    //SRU_koder.push(record[0]);

	    //verbose = record[0] === "7251";

	    SRU_koder.push({
		srukod: record[0],
		ink2: record[1],
		name: record[2],
		rules: parseSRU_Rule(record[3])
	    });

	} else {
	    slask.push(record[0]);
	}
    }


    console.log("parse file: ", filename);
    //csv.parse(fs.readFileSync(filename), (err, records) => { records.forEach( r => addRecord(r) ); console.log("all rules added"); } );
    var records = parse_sync(fs.readFileSync(filename) );
    records.forEach( r => addRecord(r) );
    console.log("file parsed, num rules: ", SRU_koder.length);

    //console.log("records: ", records => ;
    //records.forEach( r => addRecord );

/* 

    parser.on('readable', function(){
	console.log("got readable chunk");
	while(record = parser.read()){
	    //console.log("record: ", record);
	    addRecord(record);
	    //output.push(record);
	}
    });

    var is = fs.createReadStream(filename);

    is.pipe(parser);

    //is.pipe(parser).pipe(process.stdout);


    is.on('end', function() {
	if(verbose) {
	    console.log("parseCSV, all data parsed");
	}
	endOfFile = true;
	cb();
    });
    //process.stdin.pipe(parser).pipe(iptvfix).pipe(stringify).pipe(process.stdout);
*/

}


if(process.argv[1] && process.argv[1].endsWith("srucsv2rules.js")) {

    console.log("argv done");

    parseCSV(process.argv[2], function () {
      console.log("Parsing done");
	SRU_koder.forEach( (v) => {
	    console.log("name: ", v.name);
	    console.log("include: ", v.rules.include);
	    console.log("exclude: ", v.rules.exclude);
	});


	//console.log("SRU_koder: ", SRU_koder);
	//console.log("slask: ", slask);
    });

    var testdata = (""+fs.readFileSync("SRU_test.se")).split(/[\r\n]+/);

    console.log("testdata[0] = [" + testdata[0] + "]");

    testdata.forEach(l => {
	var fields = l.split(/[ ]+/);
	if(fields[0] === "#SRU") {
	    var konto = fields[1];
	    var srukod = fields[2];
            var res = findSRUcode(konto);
	  if(res) {
	    console.log("SRU code for ", konto, srukod, " matches: ", res.srukod); //, JSON.stringify(res));
	  } else {
	    console.log("SRU code for KONTO: ", konto, "SRU: ", srukod, " NOMATCH");
	  }
	}
    });

    console.log("test SRU code for 1510: ", findSRUcode("1510"));
    console.log("test SRU code for 1930: ", findSRUcode("1930"));

} else {
    parseCSV("./INK2_17_P4.csv", function () {

	if(verbose) {
	    SRU_koder.forEach( (v) => {
		console.log("name: ", v.name);
		console.log("include: ", v.rules.include);
		console.log("exclude: ", v.rules.exclude);
	    });
	}
	//console.log("SRU_koder: ", SRU_koder);
	//console.log("slask: ", slask);
    });
}

function findSRUcode(account) {
  debug("find SRU code for account: ", account);

  var match = [];

  for(i = 0; i < SRU_koder.length; i++) {
    //debug("Match account against rule: ", SRU_koder[i].rules);
    if(account.match(SRU_koder[i].rules.include) && (!SRU_koder[i].rules.exclude || !account.match(SRU_koder[i].rules.exclude))) {
      //return [SRU_koder[i].code, SRU_koder[i].ink2];

      if(SRU_koder[i].rules.matchsign) {
	//console.log("Matchsign: " + SRU_koder[i].ink2 + ", " + SRU_koder[i].rules.matchsign);
	match.push(SRU_koder[i]);
      } else {
	return SRU_koder[i];
      }
    }
  }

  if(match.length) {
    return {
      srukod: match.map( (a,v) => a.rules.matchsign + ":" + a.srukod).join(","),
      ink2: match.map( (a,v) => a.rules.matchsign + ":" + a.ink2).join(","),
      name: match[0].name
    };
  }
}

exports.findSRUcode = findSRUcode;
exports.SRU_koder = SRU_koder;
