#!/usr/bin/env node

'use strict';

const readline = require('readline');

const fs = require('fs');
const stream = require('stream');
const { promisify, inherits } = require('util');
const yaml = require('yaml');

const name = "ownbox";

var confFile = name + '.json';

var verbose = false;
var interactive = false;

var options = Object.assign({
  verbose: false,
  interactive: false,
  inform: 'json',
  outform: 'jsonl'
},conf);

var debug = function debug() {
  console.log.apply(this, arguments);
}


function JsonLineWriter(options) {
 if (!(this instanceof JsonLineWriter))
   return new JsonLineWriter(options);
  stream.Writable.call(this, Object.assign({},options, { objectMode: true }));
}
inherits(JsonLineWriter, stream.Writable);

JsonLineWriter.prototype._write = function(obj, enc, callback) {
  console.log("write: " + JSON.stringify(obj));
  callback();
}

function StreamSortTransform(options) {
 if (!(this instanceof StreamSortTransform))
   return new StreamSortTransform(options);
  stream.Transform.call(this, Object.assign({},options, { objectMode: true }));
  this.entries = [];
}
inherits(StreamSortTransform, stream.Transform);

JsonLineWriter.prototype._transform = function(obj, enc, callback) {
  console.log("got object: " + JSON.stringify(obj));

  this.entries.push(obj);

  if(this.readableEnded) {
    console.log("readable ended");
    this.entries.sort( (a,b) => a[options.field] > b[options.field] ? -1 : 1)
    this.entries.forEach(o => this.push(o));
  }

  callback();
}


//JsonLineWriter.prototype._writev(objs, callback) {
//}

var conf = (fs.existsSync(confFile) && JSON.parse(fs.readFileSync(confFile))) || {};

// All numbers are stored as integers in units of 0.01 SEK
//
// Maximum representable number is 9'999'999'999'999.00
//
// that is, the market cap of Amazon Inc 13'880'074'676'337,00 SEK cannot be
// represented using this nummber storage
//
// Possible number formats
//
//   1 234
//   1 234,12
// * 1,234.12
//   1,234
//   1234.12
//   1234,12
// * 1234
//
// * supported formats


function add(a,b) {
  a += b;
  return a;
}

function sub(a,b) {
  a -= b;
  return a;
}

function mul(a,b) {
  a = a * b;
  return a;
}

function div(a,b) {
  a = a / b;
  return a;
}



function atoi(str, decimal) {
  var parts, integer, frac;

  decimal = decimal || '.';

  parts = str.split(decimal);

  if(parts.length < 2)  {
    parts[1] = "00";
  }

  if(parts.length === 2) {
    integer = parts[0];
    frac = parts[1];

    integer = 1*integer.replace(/[ ,']/g, '');
    frac = (frac.length === 2) ? 1*frac : NaN;

    //console.log("integer: ", integer);
    //console.log("frac: ", frac);

    if(!isNaN(frac) && !isNaN(integer)) {
      return 100*integer + Math.sign(integer)*frac;
    }
  }

  throw("Unhandled number format: " + str);

}

// current supported number format
//
//  1234.12
// -1234.12

function itoa(num) {
  var sign = Math.sign(num);
  var integer = (""+(Math.abs(num) / 100)).split('.')[0];
  var frac = ("00"+(Math.abs(num) % 100 | 0)).slice(-2);

  return (sign < 0 ? '-' : '') + integer + '.' + frac;
}

function lineReader(rs, ws) {
  return readline.createInterface(Object.assign({
    input: rs,
    crlfDelay: Infinity
  }, ws ? { output: ws } : {}));
}

function SEBcsv2json(cb) {
  var saldo;

  var linenum = 0;

  const fieldsSEB = 'Bokföringsdatum,Valutadatum,Verifikationsnummer,Text/mottagare,Belopp,Saldo';

  return function transform(line) {
    if(linenum === 0) {
      if(line !== fieldsSEB) {
	throw(["SEB format changed:", fieldsSEB, line].join('\n'));
      }
    } else {
      var parts = line.split(',');

      //console.log("line %d, parts: ", linenum, parts);

      var res = {
	"bokföringsdatum": parts[0],
	"valutadatum":parts[1],
	"verifikationsnummer": "SEB"+parts[2],
	"info": parts[3],
	"belopp": atoi(parts[4]),
	"saldo": atoi(parts[5]),
	"regdatum": false,
      }

      if(linenum === 1) {
	saldo = res.saldo - res.belopp;
      } else {
	if(saldo !== res.saldo) {
	  throw("Invalid SEB transaction list, balance mismatch, " + itoa(saldo) + " != " + itoa(res.saldo));
	}
	saldo -= res.belopp;
      }
      cb(res);
    }
    linenum++;
  };
}

function SEBcsv2jsonTransform(options) {
 if (!(this instanceof StreamSortTransform))
   return new StreamSortTransform(options);
  stream.Transform.call(this, Object.assign({},options, { objectMode: true }));
  this.seb = SEBcsv2json();
}
inherits(SEBcsv2jsonTransform, stream.Transform);
SEBcsv2jsonTransform.prototype._transform = function(line, enc, callback) {
  console.log("got line: " + line);
  this.seb(line, this);
  callback();
}

function SKVcsv2json(cb) {
  var saldo;

  var linenum = 0;

  var vernum = 1;

  var verdatum;

  return function transform(line) {
    var parts = line.split(';');

    //console.log("parts: ", parts);

    if(linenum === 0) {
      if(!parts[1].startsWith("Ingående saldo")) {
	throw("SKV format changed, not starting with \"Ingående saldo\"");
      }
      saldo = atoi(parts[2]);
    } else if (parts[1].startsWith("Utgående saldo")) {
      if(atoi(parts[2]) !== saldo) {
	throw("Invalid SKV transaction list, balance mismatch, " + itoa(atoi(parts[1])) + " != " + itoa(saldo));
      }
    } else {
      //console.log("line %d, parts: ", linenum, parts);

      verdatum = verdatum || parts[0];

      if(verdatum !== parts[0]) {
	verdatum = parts[0];
	vernum = 1;
      }

      var res = {
	"bokföringsdatum": parts[0],
	"valutadatum":parts[0],
	"verifikationsnummer": "SKV"+parts[0]+':'+vernum,
	"info": parts[1],
	"belopp": atoi(parts[2]),
	"saldo": saldo
      }

      vernum++;

      saldo = res.saldo + res.belopp;

      cb(res);
    }

    linenum++;
  };
}


/*

const company = (fs.existsSync(confFile + ".yml") && JSON.parse(fs.readFileSync(confFile).toString('utf8'))) ||
             (fs.existsSync(confFile + ".yml") && JSON.parse(fs.readFileSync(confFile).toString('utf8'))) ||
      {};

*/

var accounts = {};
var transactions = {};






function readBook(rs) {
  return new Promise( (resolve, reject) => {
    var lineReader = readline.createInterface({
      input: rs
    });

    lineReader.on('line', function (line) {
      var entry = line && JSON.parse(line);

    });

    lineReader.on('close', function () {
      debug('all lines read, count:',  map.size);
      cb && cb(false, map);
    });

    rs.on('error', function (err) {
      logger.error('Failed read %s:',  err);
      cb && cb(err);
    });
  });
}


var cmds = {
  atoi: function (str) {
    console.log("num: " + atoi(str));
    console.log("itoa: " + itoa(atoi(str)));
  },
  itoa: function(num) {
    console.log("itoa: " + itoa(1*num));
  },
/*
  seb: function(infile, outfile) {
    var transactions = [];
    var t = SEBcsv2json((t) => {
      transactions.push(t);
    });
    lineReader(fs.createReadStream(infile, { encoding: 'latin1'}).on('end', () => {
      console.log("all lines read, transactions: " + transactions.length);
      var ws = outfile ? fs.createWriteStream(outfile) : process.stdout;
      while(transactions.length > 0) {
	ws.write(JSON.stringify(transactions.pop())+'\n')
      }
    })).on('line', (line) => t(line));
    //lineReader(fs.createReadStream(infile, { encoding: 'latin1'}), new SEBcsv2jsonTransform().pipe(new JsonLineWriter()));
    //lineReader(fs.createReadStream(infile, { encoding: 'latin1'}), new SEBcsv2jsonTransform());
  },
*/
  seb: function(infile, outfile) {
    var ws = outfile ? fs.createWriteStream(outfile) : process.stdout;
    var t = SEBcsv2json((t) => {
      ws.write(JSON.stringify(t)+'\n');
    });
    lineReader(fs.createReadStream(infile, { encoding: 'latin1'}).on('end', () => {
      console.log("SEB done");
    })).on('line', (line) => t(line));

    /*
    var t = SKVcsv2json();
    var os = new JsonLineWriter();
    lineReader(fs.createReadStream(filename, { encoding: 'latin1'})).on('line', (line) => t(line, os));
    */
  },
  skv: function(infile, outfile) {
    var ws = outfile ? fs.createWriteStream(outfile) : process.stdout;
    var t = SKVcsv2json((t) => {
      ws.write(JSON.stringify(t)+'\n');
    });
    lineReader(fs.createReadStream(infile, { encoding: 'latin1'}).on('end', () => {
      console.log("SKV done");
    })).on('line', (line) => t(line));

    /*
    var t = SKVcsv2json();
    var os = new JsonLineWriter();
    lineReader(fs.createReadStream(filename, { encoding: 'latin1'})).on('line', (line) => t(line, os));
    */
  },
  mergetransactions: function() {
  }
};



var args = JSON.parse(JSON.stringify(process.argv.slice(2)));

options.interactive = process.stdout.isTTY ? true : false;

for(var i = 0; i < args.length; i++) {
  //console.log("check option: " + i + ", remaining args: ", args);

  if(args[i].startsWith("-") && !args[i].match(/-\d/)) {
    if(opts[args[i]]) {

      switch(typeof options[opts[args[i]]]) {
      case 'boolean':
	options[opts[args[i]]] = true;
	break;

      case 'number':
	options[opts[args[i]]] = 1*args[i+1];
	args.splice(i, 1);
	break;

      case 'string':
	options[opts[args[i]]] = ""+args[i+1];
	args.splice(i, 1);
	break;

      }
    } else {
      console.error("Unknown option: " + args[0] + ", valid options: ", Object.keys(opts));
      alldone();
      process.exit();
    }
    args.splice(i--, 1);
  }
}

verbose = options.verbose;
interactive = options.interactive && !options.nonInteractive;

if(!options.debug) {
  debug = function() {};
}

if(verbose) {
  debug("run command: " + ('<' + args[0] + '>' || "<none>") + ", using options: " + JSON.stringify(options, null, 2));
}

Object.assign(cmds, exports);

// Remote access print eval loop
if(options.repl) {
  startRepl();
}

cmds[args[0]] ? cmds[args[0]].apply(this, args.slice(1)) : (console.error("Unknown command: " + args[0] + ", valid commands: ", Object.keys(cmds)), alldone());


