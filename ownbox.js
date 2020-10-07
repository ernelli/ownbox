#!/usr/bin/env node

'use strict';

const readline = require('readline');

const fs = require('fs');
//const fsp = require('fs/promises');
const stream = require('stream');
const { promisify, inherits } = require('util');
const yaml = require('yaml');

const name = "ownbox";

var confFile = "config" + '.json';

var verbose = false;
var interactive = false;

var conf = (fs.existsSync(confFile) && JSON.parse(fs.readFileSync(confFile))) || {};

var options = Object.assign({
  verbose: false,
  interactive: false,
  inform: 'json',
  outform: 'jsonl',
  rar: 0,
},conf);

var opts = {
  "-v": "verbose",
};

function dasher(str) {
  var differ = str.toLowerCase();
  return differ.split("").reduce( (a, v, i) => i && str.indexOf(v,i) !== i ? a.concat("-"+v) : a.concat(v), "");
}

Object.keys(options).forEach(k => { opts['--' + dasher(k)] = k; });

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

function compare(a,b) {
  return Math.sign(a-b);
}

const ZERO = atoi("0");


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
	"info": parts[3].replace(/,/g,'.') + ',' + parts[2],
	"belopp": atoi(parts[4]),
	"saldo": atoi(parts[5]),
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

/*
  JSON book entry

  { "label": "KONTO", "kontonr": "1510", "kontonamn":"Kundfodringar", kontotyp: "T", ib: 121000 }
  { "label": "KONTO", "kontonr": "1911", "kontonamn":"Bankkonto", kontotyp: "T", ib: 453000 }
  { "label": "VER", "serie": "A", "vernr": "1",   "verdatum": "2020-07-01",  "vertext": "Inbetalning faktura 45",  "regdatum": "2020-08-13", trans: [ { "kontonr": "1510",  "objekt": [],  "belopp": -111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }, { "kontonr": "1910",  "objekt": [],  "belopp": +111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }]}}

*/

console.log("Räkenskapsår: " + options.räkenskapsår);

var startDate;
var endDate;

function setDates() {
  var rar = options.räkenskapsår || "0101 - 1231";

  var now = new Date();

  now.setFullYear(now.getFullYear() + options.rar);

  var [start,end] = rar.split(" - ").map(d => d.match(/\d\d/g).map(n => 1*n));

  startDate = new Date(now.getFullYear(), start[0]-1, start[1]);
  endDate = new Date(now.getFullYear() + (start[0] > end[0] ? 1 : 0), end[0]-1, end[1]+1);

  console.log("startDate: " + startDate);
  console.log("endDate: " + endDate);
}

function dateRangeFilter(from, to, field) {
  return function(t) {
    return t[field] >= from && t[field] < to;
  }
}

function isTransactionsEqual(a, b) {
  return 1*a.transdat === 1*b.transdat &&
    a.belopp === b.belopp &&
    a.transtext === b.transtext &&
    a.kontonr === b.kontonr;
}

function transactionSortFunction(a,b) {
  //console.log("sort test: ", a.transdat, b.transdat);

  return a.transdat.getTime() !== b.transdat.getTime() ? a.transdat - b.transdat :
    (a.transtext > b.transtext ? 1 : -1);
}


// check that all transactions are unique, e.g no duplicates
function validateTransactions(transactions) {
  return transactions.reduce( (a,v,i) => {
    if(a) {
      if(i > 0) {
	return !isTransactionsEqual(v, transactions[i-1]) && transactionSortFunction(v, transactions[i-1]) > 0;
	/*
	var p = transactions[i-1];
	var res =  1*v.transdat !== 1*p.transdat ||
	    v.belopp !== p.belopp ||
	    v.transtext != p.transtext;

	return res;
	*/
      } else {
	return true;
      }
    } else {
      return false;
    }
  }, true);
}

// add transactions from newTransactions not present in transactions
function addTranscations(transactions, newTransactions) {
  var addedTransactions = [];

  var ti = 0, ni = 0;

  //console.log("add %d transactions to transacations: %d", newTransactions.length ,transactions.length);

  while(transactions[ti] || newTransactions[ni]) {
    //console.log("ni: %d, ti: %d", ni, ti);
    if(transactions[ti] && newTransactions[ni]) {
      //console.log("old t: ", transactions[ti]);
      //console.log("new t: ", newTransactions[ni]);
      if(isTransactionsEqual(transactions[ti], newTransactions[ni])) {
	ti++; // keep old
	ni++; // skip new
      } else if(transactionSortFunction(transactions[ti], newTransactions[ni]) > 0) {
	transactions.splice(ti, 0, newTransactions[ni]);
	addedTransactions.push(newTransactions[ni]);
	ti++;
	ni++;
      } else {
	ti++;
      }
    } else if(newTransactions[ni]) {
      transactions.splice(ti, 0, newTransactions[ni]);
      addedTransactions.push(newTransactions[ni]);
      ni++;
    } else {
      break;
    }
  }

//  console.log("added transactions:");
//  addedTransactions.forEach(t => console.log(JSON.stringify(t)));
//  console.log("-------------------------------:");

  if(!validateTransactions(transactions)) {
    throw("transactions invalid after add");
  }

  return addedTransactions;
}

var accounts = {};

/* account
{
  kontonr: "1510"
  kontonamn: "Kundfodringar"
  kontotyp: "", // T, S, K, I

  ib: 121000,
  saldo: 9200,  // maps against res or ub during export
}
*/

var transactions = [];
/*
{
  kontonr: "1510",
  objekt: [],
  belopp: -111800,
  transdat: "2020-07-01",
  transtext: "Inbetalning faktura 45",
  registred: "A1",
}
*/

var verificationSeries = 'A';
var verificationNumber = 1;

var verifications = [];
/*
{
  serie: 'A',
  vernr: 1,
  verdatum: "2020-07-01",
  vertext: "Inbetalning faktura 45",
  regdatum: "2020-08-13",
  transactions: [],
}
*/


function validateVerification(ver) {
  if(!ver.transactions || ver.transactions.length === 0) {
    return false;
  }

  var sum = atoi("0");
  ver.transactions.forEach(t => { sum = add(sum, t.belopp) });
  if(compare(sum, ZERO) !== 0) {
    console.log("transactions balance mismatch: " + itoa(sum));
    return false;
  }

  return true;
}


function addVerification(ver) {

  validateVerification(ver);


  if(!ver.regdatum) {
    ver.verdatum = ver.transactions[0].transdat;
  }

  ver.regdatum = Date.now();

  ver.serie = verificationSeries;
  ver.vernr = verificationNumber++;

  const verId = ver.serie + ver.vernr;

  ver.transactions.forEach(t => {
    t.registred = verId;

    
  });

  verifications.push(ver);
}



function readJsonStream(rs, array) {
  array = array || [];

  return new Promise( (resolve, reject) => {
    var lineReader = readline.createInterface({
      input: rs
    });

    lineReader.on('line', function (line) {
      var entry = line && JSON.parse(line);
      if(entry && entry.transdat) {
	entry.transdat = new Date(entry.transdat);
      }
      entry && array.push(entry);

    });

    lineReader.on('close', function () {
      return resolve(array);
    });

    rs.on('error', function (err) {
      //console.log('readJsonStream Failed: ', err);
      return reject(err);
    });
  });
}

function readJsonFile(filename, array) {
  return readJsonStream(fs.createReadStream(filename), array);
};

function safeReadJsonFile(filename, array) {
  return readJsonFile(filename, array)
    .then( res => Promise.resolve(res))
    .catch(err => (err.code === 'ENOENT') ? Promise.resolve(array) : Promise.reject(err));
}

var cmds = {
  atoi: function (str) {
    console.log("num: " + atoi(str));
    console.log("itoa: " + itoa(atoi(str)));
  },
  itoa: function(num) {
    console.log("itoa: " + itoa(1*num));
  },
  yaml: function() {
    var ver = { "label": "VER", "serie": "A", "vernr": "1",   "verdatum": "2020-07-01",  "vertext": "Inbetalning faktura 45",  "regdatum": "2020-08-13", transactions: [ { "kontonr": "1510",  "objekt": [],  "belopp": -111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }, { "kontonr": "1910",  "objekt": [],  "belopp": +111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }]};

    console.log(yaml.stringify(ver));

  },
  ver: function() {
    var ver = { "label": "VER", "serie": "A", "vernr": "1",   "verdatum": "2020-07-01",  "vertext": "Inbetalning faktura 45",  "regdatum": "2020-08-13", transactions: [ { "kontonr": "1510",  "objekt": [],  "belopp": -111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }, { "kontonr": "1910",  "objekt": [],  "belopp": +111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }]};

    console.log("validate: " + validateVerification(ver));

    console.log("parse: " , yaml.parse(
`
label: VER
serie: A
vernr: "1"
verdatum: 2020-07-01
vertext: Inbetalning faktura 45
1510: -111800
1910: 111800
`));

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
  mergetransactions: function(transactionsFile, sebFile, skvFile) {
    safeReadJsonFile(transactionsFile, transactions).then( () => {
      //console.log("transactions length: " + transactions.length);
      return Promise.all([readJsonFile(sebFile), readJsonFile(skvFile)]).then( ([seb, skv]) => {
	//console.log("seb: " + seb.length);
	//console.log("skv: " + skv.length);

	var mergedTransactions = seb.map(t => ({
	  kontonr: "1911",
	  belopp: t.belopp,
	  transdat: new Date(t.bokföringsdatum),
	  transtext: t.info,
	})).concat(skv.map(t => ({
	  kontonr: "1630",
	  belopp: t.belopp,
	  transdat: new Date(t.bokföringsdatum),
	  transtext: t.info,
	}))).filter(dateRangeFilter(startDate, endDate, 'transdat')).sort( (a,b) => {

	  return a.transdat.getTime() !== b.transdat.getTime() ? a.transdat - b.transdat :
	    (a.transtext > b.transtext ? 1 : -1);
	});

	if(!validateTransactions(mergedTransactions)) {
	  console.log("merged transaction has duplicates!!!");
	  return;
	}

	//mergedTransactions.forEach(t => console.log(JSON.stringify(t)));

	var addedTransactions = addTranscations(transactions, mergedTransactions);
	console.log("added %d transactions", addedTransactions.length);

	//console.log("write file: " + transactionsFile);

	var ws = fs.createWriteStream(transactionsFile);
	ws.on('finish', () => {
	  console.log("all data written");
	});

	transactions.forEach(t => {
	  //console.log("write t: " + JSON.stringify(t).length);
	  ws.write(JSON.stringify(t) + '\n');
	});

	ws.end();
      });
    });
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

setDates();

if(verbose) {
  debug("run command: " + ('<' + args[0] + '>' || "<none>") + ", using options: " + JSON.stringify(options, null, 2));
}

Object.assign(cmds, exports);

// Remote access print eval loop
if(options.repl) {
  startRepl();
}

cmds[args[0]] ? cmds[args[0]].apply(this, args.slice(1)) : (console.error("Unknown command: " + args[0] + ", valid commands: ", Object.keys(cmds)), alldone());


