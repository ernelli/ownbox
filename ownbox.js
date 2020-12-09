#!/usr/bin/env node

'use strict';

const readline = require('readline');

const fs = require('fs');
const fsp = require('fs').promises;
const stream = require('stream');
const { promisify, inherits } = require('util');
const YAML = require('yaml');

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
  accountingFile: "",
  transactionsFile: "", //"transactions.json",
  baskontoplan: "Kontoplan_Normal_2020.csv",
  verifications: "verifications",
  autobook: false,
  commit: false,
  infile: "",
},conf);


var finansialYearString;


var skattesatser = {
  arbetsgivaravgift: 3142,
  särskildlöneskatt: 2426,
  bolagsskatt:       2140,
  moms:              2500,
}

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

function json(o) {
  return JSON.stringify(o);
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


////////////////////////////////////////
//
// Number conversion and arithmetic
//
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

function neg(num) {
  return -num;
}

function muldiv(num, mul, div) {
  return Math.round((num*mul)/div);
}

function compare(a,b) {
  return Math.sign(a-b);
}

function equal(a,b) {
  return compare(a,b) === 0;
}

function fromNumber(n) {
  return Math.round(n*100);
}

function iszero(num) {
  // IEEE754 negative 0 compares true to 0
  if(num === 0) {
    return true;
  } else {
    return false;
  }
}

const ZERO = atoi("0");

function zero() {
  return atoi("0")
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

////////////////////////////////////////
//
// CSV parsing and imports

function parseCSV2Array(str, options) {
  return str.split(",").reduce( (a,v,i) => {

    // cases
    // ,"foo",         => [ ...,"foo",...
    // ,"foo,bar",     => [ ...,"foo,bar",...
    // ,"foo,bar,baz", => [ ...,"foo,bar,baz",...
    // ,"foo,",        => [ ...,"foo,",...

    //console.log("reduce: [" + v + "]");

    if(v.endsWith("\"")) {
      if(!v.startsWith("\"") || v.length < 2) {
	// concatenate parts

	do {
	  v = a.pop() + ',' + v;
	} while(a.length > 0 && !v.startsWith("\""))

	if(!v.startsWith("\"")) {
	  console.log(str);
	  throw("Invalid CSV, unterminated \"");
	}
      }
      // remove double quote
      v = v.match(/\"([^\"]*)\"/)[1]
    }

    a.push(v);

    return a;
  }, []).map(c => c.trim());
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

  { "type": "KONTO", "kontonr": "1510", "kontonamn":"Kundfodringar", kontotyp: "T", ib: 121000 }
  { "type": "KONTO", "kontonr": "1930", "kontonamn":"Bankkonto", kontotyp: "T", ib: 453000 }
  { "type": "VER", "serie": "A", "vernr": "1",   "verdatum": "2020-07-01",  "vertext": "Inbetalning faktura 45",  "regdatum": "2020-08-13", trans: [ { "kontonr": "1510",  "objekt": [],  "belopp": -111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }, { "kontonr": "1930",  "objekt": [],  "belopp": +111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }]}}

*/

function printTable(arr) {
  var header = Object.keys(arr[0]);
  var widths = header.map(h => 1+h.length);
  arr.forEach(r => {
    header.forEach( (k,i) => { widths[i] = (widths[i] < r[k].length) ? r[k].length : widths[i]; });
  });
  var pad = new Array(widths.reduce( (a, v) => (v > a ? v : a), 0)).fill(' ').join('');
  console.log("widths: ", widths, "pad: ", pad.length);
  console.log(header.map( (h,i) => (h + pad).slice(0, widths[i])).join(','));
  arr.forEach(r => console.log(header.map( (k,i) => (r[k] + pad).slice(0, widths[i])).join(',')));
}

function formatDate(d, separator) {
  return [ ""+d.getFullYear(), ("00"+(1+d.getMonth())).slice(-2), ("00"+d.getDate()).slice(-2)].join(typeof separator !== 'undefined' ? separator : '-');
}

function addDays(d, days) {
  return new Date(d).setDate(d.getDate() + days);
  return d;
}

console.log("Räkenskapsår: " + options.räkenskapsår);

var ledgerFile;
var transactionsFile;

var startDate;
var endDate;

function setDates() {
  var rar = options.räkenskapsår || "0101 - 1231";

  var now = new Date();

  now.setFullYear(now.getFullYear() + options.rar);

  var [start,end] = rar.split(" - ").map(d => d.match(/\d\d/g).map(n => 1*n));

  console.log("start-end: ", [start,end]);

  startDate = new Date(now.getFullYear(), start[0]-1, start[1]);
  console.log("endDate args: ", now.getFullYear() + (start[0] > end[0] ? 1 : 0), end[0]-1, end[1] + 1);
  endDate = new Date(now.getFullYear() + (start[0] > end[0] ? 1 : 0), end[0]-1, end[1] + 1);

  // endDate extends into next day for range queries to work properly
  // printDate is 0101 - 1231
  var endPrintDate = new Date(now.getFullYear() + (start[0] > end[0] ? 1 : 0), end[0]-1, end[1]);

  console.log("startDate: " + startDate);
  console.log("endDate: " + endDate);

  finansialYearString = formatDate(startDate, ".") + "-" + formatDate(endPrintDate, ".");

  console.log("finansialYearString: " + finansialYearString);
}


function dateRangeFilter(from, to, field) {
  return function(t) {
    return t[field] >= from && t[field] < to;
  }
}

function isTransactionsEqual(a, b) {
  var res = 1*a.transdat === 1*b.transdat &&
    a.belopp === b.belopp &&
    a.transtext === b.transtext &&
    a.kontonr === b.kontonr;

  //console.log("EQUAL: " + JSON.stringify(a) + ", " + JSON.stringify(b) + " => " + res);

  return res;
}

function transactionSortFunction(a,b) {
  //console.log("sort test: ", a.transdat, b.transdat);

  return a.transdat.getTime() !== b.transdat.getTime() ? a.transdat - b.transdat :
    (a.transtext === b.transtext ? 0 : (a.transtext > b.transtext ? 1 : -1));
}

function trans(kontonr, belopp, transtext) {
  return Object.assign({
    kontonr: kontonr,
    objekt: [],
    belopp: belopp,
  }, transtext ? { transtext: transtext } : {});
}

function motkonto(kontonr) {
  return {
    kontonr: kontonr,
    objekt: [],
    belopp: 0,
    transtext: "",
  };
}

// check that all transactions are unique, e.g no duplicates and in order
function validateTransactions(transactions) {

/*
  console.log("validateTransactions");
  transactions.forEach(t => {
    console.log(t.transdat, t.kontonr, t.transtext);
  });
*/
  return transactions.reduce( (a,v,i) => {
    //console.log("reduce: ", v.transdat, v.transtext);
    if(a) {
      if(i > 0) {
	//return !isTransactionsEqual(v, transactions[i-1]) && transactionSortFunction(v, transactions[i-1]) >= 0;

	if(isTransactionsEqual(v, transactions[i-1])) {
	  console.log("duplicate transactions: ", v, transactions[i-1]);
	  return false;
	}

	if(transactionSortFunction(v, transactions[i-1]) < 0) {
	  console.log("transactions out of order: ", v, transactions[i-1]);
	  return false;
	}

	return true;

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

  if(!validateTransactions(transactions)) {
    throw("transactions invalid before add");
  }

  if(!validateTransactions(newTransactions)) {
    throw("newTransactions invalid before add");
  }


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

// 1, 2, 3, 4 => (Q1, Q2, Q3, Q4)
function getTransactionsPeriod(transactions, period) {
  if(typeof transactions === 'string') {
    transactions = accounts[transactions].trans;
  }

  period = period - 1;
  return transactions.filter(t => ((t.transdat.getMonth() / 3 | 0) === period) );
}

function sumTransactions(trans) {
  var sum = atoi("0");
  trans.forEach(t => { sum = add(sum, t.belopp); });
  return sum;
}

function sumPeriod(account, period) {
  console.log("sumPeriod: " + account);
  var trans = getTransactionsPeriod(account, period);
  var sum = atoi("0");
  trans.forEach(t => { sum = add(sum, t.belopp); });
  return sum;
}

function validateBook() {
  verifications.forEach(v => {
    if(!validateVerification(v)) {
      throw ("invalid book, verification not valid: " + JSON.stringify(v));
    }
  });
}

var basKontoplan = {};
var kontoGrupper = {};
var kontoKlasser = {};

function basKontotyp(kontonr) {
  if (kontonr.startsWith("1")) {
    return 'T';
  } else if(kontonr.startsWith("2")) {
    return 'S';
  } else if(kontonr.startsWith("3")) {
    return 'I';
  } else if(kontonr.startsWith("8")) {

  } else {
    return 'K';
  }

}

function isBalanskonto(kontonr) {
  var typ = basKontotyp(kontonr);
  if(typ === 'T' || typ === 'S') {
    return true;
  } else {
    return false;
  }
}

// Urval:     ■ \u25a0
// Ändring:   |  \u2759"
function importBaskontoplan(filename) {
  var prevLine = "";

  return new Promise( (resolve, reject) => {

    lineReader(fs.createReadStream(filename, { encoding: 'utf8'}).on('end', () => {
      console.log("baskontoplan done");
      //Object.keys(basKontoplan).forEach(k => console.log(basKontoplan[k].kontonr + ": " + basKontoplan[k].kontonamn));
      return resolve();
    })).on('line', (line) => {
      //console.log("got line: " + line);

      if( (line.match(/\"/g) || []).length % 2 === 1) {
	//console.log("odd quotes: " + line);
	prevLine += line + '\n';
	return;
      }

      if(prevLine.length) {
	line = prevLine + line;
	prevLine = "";
      }

      //var parts = line.split(',').map(p => {
      //  return p.replace(/"/g, '').trim();
      //});


      var cols = parseCSV2Array(line);

      //console.log("parts: ", cols);

      //if(cols[1] && cols[1].match(/^\d$/)) {
      //  console.log("kontoklass: " + cols[1] + " : " + cols[2]);
      //}

      function addBASAccount(kontonr, kontonamn) {
	basKontoplan[kontonr] = {
	  kontonr: kontonr,
	  kontonamn: kontonamn.replace('\n', ' '),
	};
      }

      if(cols[1]) {
	if(cols[1].match(/^\d\d\d\d$/)) {
	  //console.log(cols[1] + " : [" + cols[2] + "]");
	  addBASAccount(cols[1], cols[2]);
	} else if( cols[1].match(/^\d\d$/)) {
	  kontoGrupper[cols[1]] = cols[2];
	  //console.log("kontogrupp: " + cols[1] + " : " + cols[2]);
	}	else if( cols[1].match(/^\d\d.\d\d/)) {
	  kontoGrupper[cols[1]] = cols[2];
	  //console.log("kontogrupp: " + cols[1] + " : " + cols[2]);
	} else if(cols[1].match(/^\d$/)) {
	  kontoKlasser[cols[1]] = cols[2];
	  //console.log("kontoklass: " + cols[1] + " : " + cols[2]);
	} else if(cols[1]) {

	  //console.log("LINE: " + line);
	  //console.log("unmatched group: [" + cols[1] + "] : " + cols[2]);
	}
      }

      if(cols[4] && cols[4].match(/^\d\d\d\d$/)) {
	//console.log(cols[4] + " : [" + cols[5] + "]");
	addBASAccount(cols[4], cols[5]);
      }
    });

  });
}

// huvudboken
var accounts = {};
var accountsList = [];

/* account
{
  kontonr: "1510"
  kontonamn: "Kundfodringar"
  kontotyp: "", // T, S, K, I

  ib: 121000,
  saldo: 9200,  // maps against res or ub during export

  trans: []
}
*/

function addAccount(kontonr, kontonamn, kontotyp) {
  var account = {
    kontonr: kontonr,
    kontonamn: kontonamn || basKontoplan[kontonr].kontonamn,
    kontotyp: kontotyp || basKontotyp(kontonr),
    ib: ZERO,
    saldo: ZERO,
    trans: [],
  };

  if(accounts[kontonr]) {
    throw ("addAccount failed, " + kontonr + " already exists");
  }

  accounts[kontonr] = account;
  accountsList.push(account);
}

// imported transactions for autobooking
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

// grundboken
var verifications = [];
/*
{
  serie: 'A',
  vernr: 1,
  verdatum: "2020-07-01",
  vertext: "Inbetalning faktura 45",
  regdatum: "2020-08-13",
  trans: [],
}
*/

function dumpBook() {
  Object.keys(accounts).map(k => accounts[k]).forEach(a => {
    console.log(JSON.stringify(a));
  });

  verifications.forEach(v => {
    console.log(JSON.stringify(v));
  });
}

function writeBook(book, filename) {
  var ws = fs.createWriteStream(filename);

  book.accountsList.forEach(a => {
    ws.write(JSON.stringify({"KONTO": { kontonr: a.kontonr, kontonamn: a.kontonamn, ib: a.ib, saldo: a.saldo } }) + '\n');
  });

  book.verifications && book.verifications.forEach(v => {
    ws.write(JSON.stringify({ "VER": v })+'\n');
  });
  ws.close();

  return ws;

}

function readBook(filename) {
  console.log("readBook " + filename);
  return new Promise( (resolve, reject) => {

    var firstLine = true;
    var jsonFile = false;

    var fileData = "";

    var rs = fs.createReadStream(filename);

    var lr = lineReader(rs);

    rs.on('error', err => {
      //console.log("failed to readBook: ", err);
      return resolve();
    });

    lr.on('line', line => {
      var data;

      //console.log("readBook, LINE: " + line);

      // detect line delimited JSON or JSON file
      if(firstLine && line.trim().length > 0) {
	try {
	  data = JSON.parse(line);
	} catch(e) {
	  jsonFile = true;
	}
	firstLine = false;
      }

      if(!firstLine && !jsonFile && line.length > 0) {
	data = JSON.parse(line);
      }

      if(jsonFile) {
	fileData += line + '\n';
      } else if(data) {
	//console.log("DATA: ", data);

	var type = Object.keys(data)[0];
	var obj = data[type];

	if(type === 'VER') {
	  verifications.push(obj);
	} else if(type === 'KONTO') {
	  if(accounts[data.kontonr]) {
	    return reject("error reading accounting file, " + obj.kontonr + " already exits");
	  }
	  accounts[obj.kontonr] = obj;
	  accountsList.push(obj);
	}
      }
    });

    lr.on('close', () => {
      console.log("readbook done");

      if(jsonFile) {
	var data = JSON.parse(fileData);

	if(data.konton) {
	  Object.keys(data.konton).forEach(k => {
	    var konto = data.konton[k];

	    accounts[k] = Object.assign({
	      kontonr: k,
	      kontonamn: konto.name,
	      saldo: fromNumber(typeof konto.ib === 'number' ? konto.ib : 0),
	    }, typeof konto.ib === 'number' ? { ib: fromNumber(konto.ib) } : {});
	    accountsList.push(accounts[k]);
	  });
	}

	if(data.verifikationer) {
	  data.verifikationer.forEach(v => {
	    addVerification({
	      verdatum: new Date(v.datum),
	      vertext: v.beskrivning + "," + v.id,
	      trans: v.trans.map(t => ({
		kontonr: t.konto,
		belopp: fromNumber(t.belopp)
	      }))
	    });
	  });
	}
      }
      accountsList.forEach(k => {
	if(typeof k.ib === 'number' && k.saldo === 0) {
	  k.saldo = k.ib;
	}
	if(!k.trans) {
	  k.trans = [];
	}
      });
      validateBook();
      return resolve();
    });
  });
}

function transferBook() {
  var nextYear = accountsList.map(a => Object.assign(
    {
      kontonr: a.kontonr,
      kontonamn: a.kontonamn,
      kontotyp: a.kontotyp,
    },
    isBalanskonto(a.kontonr) ? { ib: a.saldo, saldo: 0 } : { saldo: 0},
    { trans: [] }
  ));
  return nextYear;
}

function verificationSortFunction(a,b) {
  return  a.verdatum - b.verdatum;
}

function validateVerification(ver) {
  if(!ver.trans || ver.trans.length === 0) {
    return false;
  }

  var sum = atoi("0");
  //console.log("checksum: ", ver.trans);
  ver.trans.forEach(t => { sum = add(sum, t.belopp) });
  if(compare(sum, ZERO) !== 0) {
    console.log("trans balance mismatch: " + itoa(sum));
    ver.trans.forEach(t => console.log(itoa(t.belopp)));
    return false;
  }

  return true;
}


function addVerification(ver) {
  // check if autobalance/motkonto exists

  var motkonto = ver.trans.find(t => iszero(t.belopp));
  if(motkonto) {
    var sum = atoi("0");
    //console.log("checksum: ", ver.trans);
    ver.trans.forEach(t => { sum = add(sum, t.belopp) });
    if(iszero(sum)) {
      // motkonto redundant, remove
      ver.trans = ver.trans.filter(t => (t !== motkonto) );
    } else {
      motkonto.belopp = neg(sum);
    }
  }

  if(!validateVerification(ver)) {
    throw("addVerification failed, Invalid verification");
  }

  ver.trans = ver.trans.map(t => {
    if(t.registred) {
      throw("Transaction already registred in verification: " + t.registred + ", " + JSON.stringify(t));
    }

    // find matching transaction in unbooked transactions
    var mt = findTransaction(t.transtext || ver.vertext, t.kontonr, t.belopp, t.transdat, t.transdat);
    if(mt) {
      return mt;
    } else {
      return t;
    }
    //var findTransaction(t)
  });

  if(!ver.verdatum) {
    ver.verdatum = ver.trans[0].transdat || (new Date());
  }

  // always use current date as regdatum
  ver.regdatum = new Date();

  ver.serie = verificationSeries;
  ver.vernr = verificationNumber++;

  const verId = ver.serie + ver.vernr;

  ver.trans.forEach(t => {
    t.registred = verId;
    if(!accounts[t.kontonr]) {
      addAccount(t.kontonr);
    }
    if(!t.transdat) {
      t.transdat = ver.verdatum;
    }
    accounts[t.kontonr].saldo = add(accounts[t.kontonr].saldo, t.belopp);
    accounts[t.kontonr].trans.push(t);
  });

  verifications.push(ver);
  verifications.sort(verificationSortFunction);
}

function readFileUTF8(filename) {
  return fs.promises.readFile(filename, 'utf8');
}

function importVerification(data) {
  var ver = {};

  ver.verdatum = data.verdatum || (ver.trans.find(t => !!t.transdat) || {}).transdat || formatDate(new Date());
  if(typeof ver.verdatum === 'string') {
    ver.verdatum = new Date(ver.verdatum);
  }
  ver.vertext = data.vertext;
  ver.trans = data.trans.map(t => {
    var ret = {};
    if(t.kontonr) {
      ret.kontonr = t.kontonr;
      ret.belopp = fromNumber(t.belopp);
    } else {
      ret.kontonr = Object.keys(t).find(k => k.match(/\d\d\d\d/));
      ret.belopp = fromNumber(t[ret.kontonr]);
    }
    ret.transdat = data.transdat || ver.verdatum;
    if(data.transtext) {
      ret.transtext = data.transtext;
    }
    return ret;
  });

  addVerification(ver);
  return ver;
}

function importYamlVerificationFile(filename) {
  debug("read yaml file: " + filename);
  var p = readFileUTF8(filename).then( yaml => {
    debug("readFileUTF8 done");
    var data = YAML.parseAllDocuments(yaml);
/*
    , function(holder, key, value) {
      console.log("add key: " + key, ", value: ", value);
    });
*/
    //console.log("got YAML data: ", data);

    data.forEach(d => {
      debug("data: ", d.toJSON());
      let ver = importVerification(d.toJSON());
      debug("imported verification: " + JSON.stringify(ver, null, 2));
    });
    debug("all verifications imported");
  });

  return p;
}


async function importVerifications() {
  console.log("importVerifications called");

  return new Promise( async (resolve,reject) => {
    var files = await fsp.readdir(options.verifications);

//    fs.readdir(options.verifications, (err, files) => {
      debug("importVerifications got files: ", files);
    for (const f of files) {
      if(!f.startsWith('.#') && f.endsWith(".yaml")) {
	debug("import verification file: " + f);
	await importYamlVerificationFile([options.verifications,f].join('/'));
	debug("importVerifications, yaml file imported");
      }
    }

//  });

    console.log("importVerifications done");

    return resolve();
//    });
  });

}

function matchTransaction(t, reg, kontonr, belopp) {
  //var m = [ (!reg || !!t.transtext.match(reg)) , (!kontonr || t.kontonr === kontonr) , (!belopp || t.belopp === belopp) ];
  //console.log("matcher: ", m, JSON.stringify(t));

  return (!reg || t.transtext.match(reg)) && (!kontonr || t.kontonr === kontonr) && (!belopp || t.belopp === belopp);
}

function findTransaction(reg, kontonr, belopp, dateFrom, dateTo) {
  if(reg && kontonr && belopp && dateFrom && dateTo) {

  var match = (typeof reg === 'string') ?
      function strmatcher(str) { return str === reg } :
      function regmatcher(str) { return str.match(reg) };


  //console.log("findTransaction: ", reg, kontonr, belopp, dateFrom, dateTo);
  //console.log("findTransaction, matcher: " + match.name);

  var res = transactions.filter(t => {
    /*
    try {
      if(t.transtext && match(t.transtext)) {
	console.log("findTransaction match t: ", t);
      } else {
	console.log("findTransaction NO match t: ", reg, t.transtext);
      }
    } catch(e) {
      console.log("testing matcher failed");
      process.exit(0);
    }
    */
    return t.transtext && match(t.transtext) && equal(t.belopp, belopp) && t.transdat >= dateFrom && t.transdat <= dateTo;
  });
  if(res.length > 1) {
    console.log("res matched: ", res);
    return false;
  } else {
    return res[0];
  }
  } else {
    return false;
  }
}

////////////////////////////////////////
//
// autobook: Automatically book transactions into verifications

//function pensionTrans(belopp) {
//}

function autobook(t) {
  if(matchTransaction(t, /^SEB pension/, "1930", fromNumber(-1000))) {
    //console.log("autobook SEB pension" + JSON.stringify(t));
    addVerification({ trans: [ t, trans("7412", neg(t.belopp)),
				      trans("2514", muldiv(t.belopp, skattesatser.särskildlöneskatt, 10000)),
				      trans("7533", muldiv(neg(t.belopp), skattesatser.särskildlöneskatt, 10000))]});
  } else if(matchTransaction(t, /Länsförsäkr/, "1930", fromNumber(-11099))) {
    //console.log("autobook Länsförsäkringar pension" + JSON.stringify(t));
    let pension = fromNumber(10900.46);
    let forman = fromNumber(198.21);
    addVerification({ trans: [ t, trans("7412", pension),
			       trans("2514", muldiv(neg(pension), skattesatser.särskildlöneskatt, 10000)),
			       trans("7533", muldiv(pension, skattesatser.särskildlöneskatt, 10000)),
			       trans("7389", forman),
			       trans("2731", muldiv(forman, skattesatser.arbetsgivaravgift, 10000)),
			       trans("7512", muldiv(neg(forman), skattesatser.arbetsgivaravgift, 10000)),
			       trans("3740", fromNumber(0.33))
			     ]});
  } else if(matchTransaction(t, /Länsförsäkr/, "1930", fromNumber(-11167))) {
    //console.log("autobook Länsförsäkringar pension" + JSON.stringify(t));
    let pension = fromNumber(10952.58);
    let forman = fromNumber(214.02);
    addVerification({ trans: [ t, trans("7412", pension),
			       trans("2514", muldiv(neg(pension), skattesatser.särskildlöneskatt, 10000)),
			       trans("7533", muldiv(pension, skattesatser.särskildlöneskatt, 10000)),
			       trans("7389", forman),
			       trans("2731", muldiv(forman, skattesatser.arbetsgivaravgift, 10000)),
			       trans("7512", muldiv(neg(forman), skattesatser.arbetsgivaravgift, 10000)),
			       trans("3740", fromNumber(0.40))
			     ]});
  } else if(matchTransaction(t, /Banktjänster/, "1930", fromNumber(-100))) {
    addVerification({ trans: [ t, motkonto("6570")]});
  } else if(matchTransaction(t, /Debiterad preliminärskatt/, "1630")) {
    addVerification({ trans: [ t, motkonto("2518")]});
  } else if(matchTransaction(t, /855-4546633/, "1930")) {
    addVerification({ trans: [ t,
			       trans("6540", neg(t.belopp)),
			       trans("4531", neg(t.belopp)),
			       trans("4599", t.belopp),
			       trans("2614", muldiv(t.belopp, skattesatser.moms, 10000)),
			       trans("2645", neg(muldiv(t.belopp, skattesatser.moms, 10000))),
			     ]});
  } else if(matchTransaction(t, /Utdelning/, "1930")) {
    addVerification({ trans: [ t, motkonto("2898")]});
  } else if(matchTransaction(t, /Skatteverket/, "1930")) {
    let ts = findTransaction(/Inbetalning bokförd/, "1630", neg(t.belopp), t.transdat, addDays(t.transdat, 3))
    if(ts) {
      console.log("found matching transation: " + JSON.stringify(ts));
      addVerification({ trans: [ t, ts ]});
    }
  }
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
  findtrans: function(text, belopp, from, to) {
    safeReadJsonFile(options.transactionsFile, transactions).then( () => {
      console.log("trans: ", findTransaction(new RegExp(text), fromNumber(1*belopp), new Date(from), new Date(to)));
    });
  },
  yaml: function() {
    var ver = { "type": "VER", "serie": "A", "vernr": "1",   "verdatum": "2020-07-01",  "vertext": "Inbetalning faktura 45",  "regdatum": "2020-08-13", trans: [ { "kontonr": "1510",  "objekt": [],  "belopp": -111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }, { "kontonr": "1910",  "objekt": [],  "belopp": +111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }]};

    console.log(YAML.stringify(ver));

    var yamlText =
`foo:
  - 1
  - 2
  - 3`;

    console.log("YAML parse: ", YAML.parse(yamlText));
    //yaml2Object(YAML.parseAllDocuments(yamlText)[0].contents);

    yaml2Object(YAML.parseAllDocuments(yamlText)[0].toJSON());

  },
  csv: function(str) {
    console.log("parse: " + str);
    console.log("parsed: ", parseCSV2Array(str));
  },
  baskontoplan: function(filename) {
    importBaskontoplan(filename || options.kontoplan);
  },
  autobook: function() {
    console.log("RUN autobook");
//    safeReadJsonFile(options.transactionsFile, transactions).then( () => {
      console.log("transactions read, num: " + transactions.length);

      transactions.forEach(t => {
	var ver = autobook(t);
      });

      dumpBook();

      transactions.forEach(t => {
	if(!t.registred) {
	  console.log("unbooked transaction: " + JSON.stringify(t));
	}
      });

//    });
  },
  trans: function(kontonr) {
    accounts[kontonr].trans.forEach(t => console.log(json(t)));
  },

  sum: function(kontonr) {
    console.log(kontonr);
    console.log("-------");
    accounts[kontonr] && accounts[kontonr].trans.forEach(t => console.log(itoa(t.belopp)));
    console.log("-------");
    console.log(itoa(sumTransactions(accounts[kontonr].trans)));
  },
  arbetsgivaravgifter: function(month) {


  },
  moms: function(period) {
    console.log("momsrapport för period " + period);
    console.log("account 3001 " + JSON.stringify(accounts["3001"], null, 2));
    var momsRapport = [
      [ "3001", "5" , -1], // I-Försäljning 25%
      [ "2610", "10", -1], // S-Utgående Moms 25%
      [ "4515", "20",  1], // K+Inköp varor EU 25 %
      [ "4531", "22",  1], // K+Tjänst. Utanf. EU  25 %
      [ "2614", "30", -1], // S-Utgåend moms Omv skatt 25%
      [ "4545", "50",  1], // K+Import varor 25%
      [ "2615", "60", -1], // S-Utgående moms varuimport 25 %
      [ "2640", "0",    1],   // S+Ingående Moms
      [ "2645", "0",    1]];  // S+Ingående moms Utland

    var rapport = momsRapport.map(m => ({
      fältnamn: accounts[m[0]].kontonamn.replace("\n"," "),
      fältkod: m[1],
      belopp: sumPeriod(m[0], period)
    }));

    rapport.filter(r => r.fältkod === "0").forEach(i => console.log("ing: ", i));

    var ingMoms = rapport.filter(r => r.fältkod === "0").reduce( (a,v) => add(a, v.belopp), zero());

    console.log("ingående moms: " + ingMoms);

    rapport.push({
      fältnamn: "Ingående moms totalt",
      fältkod: "48",
      belopp: ingMoms
    });

    var resMap = rapport.reduce( (a,v) => (a[v.fältkod] = v, a), {});

    rapport.push({
      fältnamn: "Moms att betala",
      fältkod: "49",
      belopp: neg(add(resMap["48"].belopp,  add(resMap["10"].belopp, add(resMap["30"].belopp, resMap["60"].belopp))))
    });

    //momsRapport.forEach(r => console.log(r[0] + " " + basKontotyp(r[0])));

    //rapport.forEach( (r,i) => (r.belopp = itoa(mul(r.belopp, fromNumber( (momsRapport[i] && momsRapport[i][2]) || 1)))));
    rapport.forEach( (r,i) => (r.belopp = itoa( (momsRapport[i] && momsRapport[i][2]) < 0 ? neg(r.belopp ): r.belopp)));

    //console.log("fältnamn, fältkod, belopp");
    //rapport.forEach(f => console.log(f.fältnamn, f.fältkod, itoa(f.belopp)));
    printTable(rapport);

  },
  book: function() {

  },
  verifications: async function () {
    await importVerifications();
    console.log("verifications imported");
    dumpBook();
  },

  ver: async function(filename) {
    var ver = { "type": "VER", "serie": "A", "vernr": "1",   "verdatum": "2020-07-01",  "vertext": "Inbetalning faktura 45",  "regdatum": "2020-08-13", trans: [ { "kontonr": "1510",  "objekt": [],  "belopp": -111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }, { "kontonr": "1910",  "objekt": [],  "belopp": +111800,  "transdat": "2020-07-01",  "transtext": "Inbetalning faktura 45" }]};

    console.log("validate: " + validateVerification(ver));

    var ver1 = YAML.parse(
`
type: VER
serie: A
vernr: "1"
verdatum: 2020-07-01
vertext: Inbetalning faktura 45
1510: -111800
1910: 111800
`);


    await importYamlVerificationFile(filename);

    dumpBook();

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
  mergetrans: function(mergeFile, account) {
//    safeReadJsonFile(options.transactionsFile, transactions).then( () => {


      //console.log("transactions length: " + transactions.length);
      return readJsonFile(mergeFile).then( (merge) => {
	//console.log("seb: " + seb.length);
	//console.log("skv: " + skv.length);

	var mergedTransactions = merge.map(t => ({
	  kontonr: account,
	  belopp: t.belopp,
	  transdat: new Date(t.bokföringsdatum),
	  transtext: t.info,
	})).filter(dateRangeFilter(startDate, endDate, 'transdat')).sort( (a,b) => {
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

	if(options.commit) {
	  console.log("write file: " + options.transactionsFile);

	  var ws = fs.createWriteStream(options.transactionsFile);
	  ws.on('finish', () => {
	    console.log("all data written");
	  });

	  transactions.forEach(t => {
	    //console.log("write t: " + JSON.stringify(t).length);
	    ws.write(JSON.stringify(t) + '\n');
	  });

	  ws.end();
	}
      });
//    });
  },
  writeBook: function (filename) {
    filename = filename || ledgerFile;
  },
  readBook: function(filename) {
    readBook(filename);
  },
  transferBook: function (filename) {
    var nextYear = transferBook();

    if(filename) {
      writeBook( { accountsList: nextYear }, filename);
    } else if(options.commit) {
      // commit into default accounting file
    }
  },
  mergetransactions: function(transactionsFile, sebFile, skvFile) {
    console.log("mergetransactions: read %s", transactionsFile);
    safeReadJsonFile(transactionsFile, transactions).then( () => {
      console.log("transactions length: " + transactions.length);
      return Promise.all([readJsonFile(sebFile), readJsonFile(skvFile)]).then( ([seb, skv]) => {
	//console.log("seb: " + seb.length);
	//console.log("skv: " + skv.length);

	var mergedTransactions = seb.map(t => ({
	  kontonr: "1930",
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

	console.log("validate merged transactions");

	if(!validateTransactions(mergedTransactions)) {
	  console.log("merged transaction has duplicates!!!");
	  return;
	}

	//mergedTransactions.forEach(t => console.log(JSON.stringify(t)));

	console.log("add transactions");
	try {
	  var addedTransactions = addTranscations(transactions, mergedTransactions);
	  console.log("added %d transactions", addedTransactions.length);
	} catch(e) {
	  if(e) {
	    console.log("Failed to add transactions:", e);
	    return;
	  }
	}

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

ledgerFile = ["accounting", options.orgnummer, finansialYearString, "json"].join('.');
transactionsFile = ["transactions", options.orgnummer, finansialYearString, "json"].join('.');

options.accountingFile = options.accountingFile || ledgerFile;
options.transactionsFile = options.transactionsFile || transactionsFile;

console.log("verbose: " + verbose);

if(verbose) {
  console.log("run command: " + ('<' + args[0] + '>' || "<none>") + ", using options: " + JSON.stringify(options, null, 2));
}

Object.assign(cmds, exports);

// Remote access print eval loop
if(options.repl) {
  startRepl();
}

async function run() {
  await importBaskontoplan(options.baskontoplan);
  await readBook(options.infile || options.accountingFile);
  await safeReadJsonFile(options.transactionsFile, transactions);
  console.log("running importVerifications, transactions: " + transactions.length);
  let verStat = await importVerifications();
  console.log("verifications imported");
  if(options.autobook) {
  console.log("run autobook");
    transactions.forEach(t => {
      var ver = autobook(t);
    });
  }
  console.log("accounting init done, run command");
  cmds[args[0]] ? cmds[args[0]].apply(this, args.slice(1)) : (console.error("Unknown command: " + args[0] + ", valid commands: ", Object.keys(cmds)), alldone());
  if(options.commit) {
    await writeBook({ accountsList: accountsList, verifications: verifications }, options.accountingFile);
  }

  console.log("alldone, dump unbooked transactions");

  transactions.forEach(t => {
    if(!t.registred) {
	  console.log("unbooked transaction: " + JSON.stringify(t));
    }
  });
  console.log("alldone, exit");
};


try {
  run().then(res => {

  }).catch(err => {
    console.log("execution failed: ", err);
  });
} catch(e) {
  console.log("execution failed: ", e);
}
