#!/usr/bin/env node

'use strict';

const readline = require('readline');

const fs = require('fs');
const fsp = require('fs').promises;
const stream = require('stream');
const util = require('util');

const finished  = (require('stream').promises || {}).finished ||
      function(s) {
	return new Promise((resolve, reject) => {
	  s.on('finish', () => {
	    return resolve();
	  });

	  s.on('error', (err) => {
	    return reject(err);
	  });
	});
      };

const { promisify, inherits } = require('util');
const YAML = require('yaml');
const Iconv = require('iconv').Iconv;

const name = "ownbox";

var confFile = "config" + '.json';

var verbose = false;
var interactive = false;

var conf = (fs.existsSync(confFile) && JSON.parse(fs.readFileSync(confFile))) || {};

var options = Object.assign({
  verbose: false,
  interactive: false,
  debug: false,
  inform: 'json',
  outform: 'jsonl',
  rar: 0,
  accountingFile: "",
  transactionsFile: "", //"transactions.json",
  baskontoplan: "Kontoplan_Normal_2020.csv",
  srukoder: "INK2_19-P1-exkl-version-2.csv",
  verifications: "verifications",
  autoMoms: false,
  autobook: true,
  noAutobook: false,
  autobookEndDate: "",
  importVerifications: true,
  noImportVerifications: false,
  noAuto: false,
  commit: false,
  forceWrite: false,
  infile: "",
  outfile: "",
  dumpTransactions: false,
  dumpAccounts: false,
  dumpVerifications: false,
  dumpUnbooked: false,
  verboseDebug: "",
  validate: false,
},conf);

var hushed = ("importSRUkoder").split(",").reduce( (a,v) => (a[v] = true,a), {});

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

var hushDebug = false;

var debug = function() {
  throw("debug logging not initialised");
}

function disableDebug() {
  debug = function() {};
}

function enableDebug() {
  debug = function debug() {
    if(hushDebug) {
      return;
    }
    console.log.apply(this, arguments);
  }
}

function json(o) {
  return JSON.stringify(o);
}



var utf8toLATIN1Converter = new Iconv("UTF-8", "ISO-8859-1");

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
  a = Math.floor(a / b);
  return a;
}

function neg(num) {
  return -num;
}

function abs(num) {
  return Math.abs(num);
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

function floor(num) {
  return num - num % 100;
}

function sum(args) {
  var sum = 0;

  if(!Array.isArray(args)) {
    args = Array.prototype.slice.call(arguments);
  }

  args.forEach(a => (sum = add(sum, a)) );

  return sum;
}

function iszero(num) {
  // IEEE754 negative 0 compares true to 0
  if(num === 0) {
    return true;
  } else {
    return false;
  }
}

function isneg(num) {
  if(Math.sign(num) < 0) {
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

function formatInteger(num) {
  return ""+(num / 100 | 0)
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

//1234567890
//1250000,00

//1234567890 
//2012-03-14

function formatValue(v) {
  if(typeof v === 'object' && v instanceof Date) {
    return "  " + formatDate(v);
  } else if (typeof v === 'number') {
    return ("            "+itoa(v)).slice(-12);
  } else {
    return (v && (" " + v)) || "";
  }

}

function printTable(arr) {
  if(arr.length === 0) {
    return;
  }

  var header = Object.keys(arr[0]);
  var widths = header.map(h => 1+h.length);
  arr.forEach(r => {
    header.forEach( (k,i) => { var vl = formatValue(r[k]).length; widths[i] = (widths[i] < vl) ? vl : widths[i]; });
  });
  var pad = new Array(widths.reduce( (a, v) => (v > a ? v : a), 0)).fill(' ').join('');
  //console.log("widths: ", widths, "pad: ", pad.length);
  console.log(header.map( (h,i) => (pad + h).slice(-widths[i])).join(','));
  arr.forEach(r => console.log(header.map( (k,i) => (pad+formatValue(r[k])).slice(-widths[i])).join(',')));
}

function convertDate(d) {
  if(typeof d === 'string') {
    return new Date(formatDate(new Date(d)));
  } else if(d instanceof Date) {
    return d;
  } else if(typeof d === 'number') {
    return new Date(d);
  } else {
    throw "Cannot convert ", d, " to Date";
  }
}

function checkDate(d) {
  if(!d instanceof Date) {
    console.log("Not a date: " + d);
  }
}

function formatNumber(n, width) {
  return ("                    "+itoa(n)).slice(-width);
}

function pad(s, width) {
  return ("                    "+s).slice(-width);
}


var month = [
  "januari",
  "ferbruari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december"];

function formatDate(d, separator) {
  return [ ""+d.getFullYear(), ("00"+(1+d.getMonth())).slice(-2), ("00"+d.getDate()).slice(-2)].join(typeof separator !== 'undefined' ? separator : '-');
}

function formatTime(d, separator) {
  return [ ("00"+d.getHours()).slice(-2), ("00"+(d.getMinutes())).slice(-2), ("00"+d.getSeconds()).slice(-2)].join(typeof separator !== 'undefined' ? separator : ':');
}

function addDays(d, days) {
  var d =  new Date(d)
  d.setDate(d.getDate() + days);
  return d;
}

function dateCompare(a, b) {
  a = new Date(formatDate(a));
  b = new Date(formatDate(b));

  if(a > b) {
    return 1;
  } else if (a < b) {
    return -1;
  } else {
    return 0;
  }
}

function dateInRange(d, from, to) {

  if(from instanceof Date && to instanceof Date) {
    return dateCompare(d, from) >= 0 && dateCompare(d, to) <= 0;
  } else if(from && from.from instanceof Date && from.to instanceof Date) {
      return dateCompare(d, from.from) >= 0 && dateCompare(d, from.to) <= 0;
  }
  throw (`dateInRange, invalid parameters ${d}, ${from}, ${to}`);
}


//console.log("Räkenskapsår: " + options.räkenskapsår);

var ledgerFile;
var transactionsFile;

var startDate;
var endDate; //this is a crutch, endDate is set to one day after financialYear

var endPrintDate; //this represents the actual endDate to be printed

var financialYearStartDate;
var financialYearEndDate;

function setDates() {
  var rar = options.räkenskapsår || "0101 - 1231";

  var now = new Date();

  now.setFullYear(now.getFullYear() + options.rar);

  var [start,end] = rar.split(" - ").map(d => d.match(/\d\d/g).map(n => 1*n));

  [financialYearStartDate, financialYearEndDate] = rar.split(" - ");

  debug("Räkenskapsår: ", [financialYearStartDate, financialYearEndDate]);

  debug("start-end: ", [start,end]);


  debug("calculate financial year startDate && endDate from %s", formatDate(now, "-"));

  startDate = new Date(now.getFullYear(), start[0]-1, start[1]);

  debug("Calculated startDate: %s", formatDate(startDate, "-"));

  debug("endDate args: ", now.getFullYear() + (start[0] > end[0] ? 1 : 0), end[0]-1, end[1] + 1);
  endDate = new Date(now.getFullYear() + (start[0] > end[0] ? 1 : 0), end[0]-1, end[1] + 1);
  endPrintDate = new Date(now.getFullYear() + (start[0] > end[0] ? 1 : 0), end[0]-1, end[1]);

  while(startDate > now) {
    startDate = new Date(startDate.getFullYear() - 1, startDate.getMonth(), startDate.getDate());
    endDate = new Date(endDate.getFullYear() - 1, endDate.getMonth(), endDate.getDate());
    endPrintDate = new Date(endPrintDate.getFullYear() - 1, endPrintDate.getMonth(), endPrintDate.getDate());
  }

  // endDate extends into next day for range queries to work properly
  // printDate is 0101 - 1231
  //var endPrintDate = new Date(now.getFullYear() + (start[0] > end[0] ? 1 : 0), end[0]-1, end[1]);


  debug("startDate: " + startDate);
  debug("endDate: " + endDate);
  debug("endPrint: " + endPrintDate);

  finansialYearString = formatDate(startDate, ".") + "-" + formatDate(endPrintDate, ".");

  console.log("finansialYearString: " + finansialYearString);

  if(options.autobookEndDate) {
    console.log("Restrict autobooking verfications/transactions up to: " + options.autobookEndDate);
    options.autobookEndDate = new Date(options.autobookEndDate);
  }
}

function dateRange(date, from, to) {
  try {
    if(from && date.getTime() < from.getTime()) {
      return false;
    }

    if(to && date.getTime() > to.getTime()) {
      return false;
    }
  } catch(e) {
    console.log("dateRange failed: ", "date: "+date, "from: "+from, "to: "+to);
    return false;
  }
  return true;
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

function isTransactionsSimilar(a, b) {
  var res = Math.abs(1*a.transdat - 1*b.transdat) <= 25*3600*1000 &&
    a.belopp === b.belopp &&
      (  (!a.transtext || !b.transtext) || a.transtext === b.transtext) &&
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


// returns false if ok, string describing error if failed. Stops on first error
// if verbose, all errors are printed on console and function returns true
function validateAccountingData(verbose) {
  var res = false;
  function report() {
    if(verbose) {
      console.log.apply(this, arguments);
      res = true;
      console.log("----------------------------------------");
    } else {
      throw util.format.apply(this, arguments);
    }
  }

  try {

    // check ingående balans
    var tillgångar = zero();
    accountsList.filter(k => basKontotyp(k.kontonr) === 'T').forEach(k => {
      tillgångar = add(tillgångar, k.ib);
    });
    var skulder = zero();
    accountsList.filter(k => basKontotyp(k.kontonr) === 'S').forEach(k => {
      skulder = add(skulder, k.ib);
    });


    debug("ingående balans");
    debug("tillgångar: " + itoa(tillgångar));
    debug("skulder: " + itoa(skulder));

    if(!equal(tillgångar,neg(skulder))) {
      report("Ingående tillgångar och skulder balanserar inte!");
    }

    var konton = accountsList.reduce( (a, k) => {
      var ktyp = basKontotyp(k.kontonr);
      if(ktyp === 'T' || ktyp === 'S') {
	a[k.kontonr] = k.ib;
      } else {
	a[k.kontonr] = zero();
      }
      return a;
    }, {});

    //console.log("Ingående balans på konton:\n", JSON.stringify(konton, null, 2));

    var prevVerdatum = 0;

    var dupCheck = new Set();

    transactions.forEach(t => {
      if(t.registred) {
	if(dupCheck.has(t)) {
	  report("transaktion felaktigt registrerad, transaktion förekommer två gånger i verfikationer");
	} else {
	  dupCheck.add(t);
	}

	var v;
	if( (v = verificationsIndex[t.registred])) {
	  var vt = v.trans.find(vt => vt === t);
	  if(!vt) {
	    report("transaktion felaktigt registrerad, transaktion saknas i verifikation %s's trans lista !\nTRANS: %s\nVER: %s", t.registred, json(t), json(v) );
	  }
	} else {
	  report("transaktion felaktigt registrerad, verifikation %s saknas!\nTRANS: %s", t.registred, json(t));
	}

      }
    });

    verifications.forEach(v => {
      debug("validerar verifikation: ", json(v));
      if(!validateVerification(v)) {
	report("verifikation felaktig, balanserar inte");
	report(JSON.stringify(v, null, 2));
      }

      if(!v.serie || !v.vernr) {
	report("verifikation saknar regid: ");
	report(JSON.stringify(v, null, 2));
      }

      if(!v.regdatum) {
	report("verifikation saknar regdatum: ", v.serie+v.vernr);
      }

      if(!v.verdatum) {
	report("verifikation saknar verdatum: ", v.serie+v.vernr);
      } else if(v.verdatum < prevVerdatum) {
	report("verifikation ligger i fel ordning: ", v.serie+v.vernr);
      }

      prevVerdatum = v.verdatum;

      var dup = new Set();

      v.trans.forEach(t => {
	if(dup.has(t)) {
	  report("transaktion %s i verifikation %s förekommer två ggr", json(t), v.serie+v.vernr);
	} else {
	  dup.add(t);
	}

	if(typeof konton[t.kontonr] === 'undefined') {
	  report("invalid transaction, kontonr %s not in acccountsList", t.kontonr);
	}
	konton[t.kontonr] = add(konton[t.kontonr], t.belopp);
	if(!t.transdat) {
	  report("transaktion saknar transaktionsdatum, ver %d, trans: %s ", v.serie+v.vernr, JSON.stringify(t));
	}
	if(!t.registred || t.registred !== (v.serie+v.vernr)) {
	  report("transaktion i verifikation %s har felaktigt registrerad verifikations id, trans: %s", v.serie+v.vernr, JSON.stringify(t));
	} else {
	  //console.log("trans regged: " + json(t));
	}

	//findTransaction(reg, kontonr, belopp, dateFrom, dateTo) {
      });
    });

    Object.keys(konton).forEach(k => {
      if(!equal(konton[k], accounts[k].saldo)) {
	report("saldo på konto stämmer inte med verifikationer: ", k);
	report("%s, %s", itoa(konton[k]), itoa(accounts[k].saldo));
      };
    });

    /*
      tillgångar = zero();
      skulder = zero();
      intäkter = zero();
      kostnader = zero();
    */

    var saldon = {
      T: zero(),
      S: zero(),
      I: zero(),
      K: zero(),
      B: zero()
    };

    /*
      var intäkter = zero();
      var kostnader = zero();
      accountsList.forEach(k => {
      var ktyp = basKontotyp(k.kontonr);
      });
    */
    /*
      accountsList.filter(k => basKontotyp(k.kontonr) === 'T').forEach(k => {
      tillgångar = add(tillgångar, k.saldo);
      });

      accountsList.filter(k => basKontotyp(k.kontonr) === 'S').forEach(k => {
      skulder = add(skulder, k.saldo);
      });
    */
    accountsList.forEach(k => {
      var typ = basKontotyp(k.kontonr);
      saldon[typ] = add(saldon[typ], k.saldo);
    });

    debug("utgående balans:");
    debug("tillgångar: " + itoa(saldon.T));
    debug("skulder: " + itoa(saldon.S));
    debug("utgående resultat:");
    debug("intäkter: " + itoa(saldon.I));
    debug("kostnader: " + itoa(saldon.K));
    debug("bokslutsposter: " + itoa(saldon.B));

    debug("balansdiff: ", itoa(add(saldon.T, saldon.S)));
    debug("resultatdiff: ", itoa(add(add(saldon.I, saldon.K), saldon.B)));

    if(!iszero(add(add(saldon.T, saldon.S),add(add(saldon.I, saldon.K), saldon.B)))) {
      report("Utgående tillgångar och skulder balanserar inte med intäkter och kostnader!");
    }
  } catch(err) {
    return err;
  }
  return res;
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


// period under räkenskapsåret,
// period 1 första 3 månaderna,
// period 2 månad 4-6 osv.
// RÅR == kalenderår =>  1, 2, 3, 4 = (Q1, Q2, Q3, Q4)

function getTransactionsPeriod(transactions, period) {
  if(typeof transactions === 'string') {
    if(accounts[transactions] && accounts[transactions].trans) {
      transactions = accounts[transactions].trans;
    } else {
      //console.log("getTransactionsPeriod, account: %s not found in accounts", transactions);
      //console.log(Object.keys(accounts));
      return [];
    }
  }

  period = period - 1;
  var startMonth = startDate.getMonth();
  return transactions.filter(t => {
//    console.log("t: ", t, ((12+t.transdat.getMonth() - startMonth) % 12), period, ((((12+t.transdat.getMonth() - startMonth) % 12) / 3 | 0) === period));

    return  ((((12+t.transdat.getMonth() - startMonth) % 12) / 3 | 0) === period);
  });
}

function sumTransactions(trans) {
  var sum = atoi("0");
  trans.forEach(t => { sum = add(sum, t.belopp); });
  return sum;
}

function saldo(account, date) {
  return add(isBalanskonto(account) ? accounts[account].ib : zero(), sumTransactions(accounts[account].trans.filter(t => {
    return dateRange(t.transdat, false, date)
  })));
}

function sumPeriod(account, period) {
  console.log("sumPeriod: " + account);
  var trans = getTransactionsPeriod(account, period);
  var sum = atoi("0");
  trans.forEach(t => { sum = add(sum, t.belopp); });
  return sum;
}

function getTransactionsMonth(transactions, month) {
  month = ((month % 12)+12)%12;

  if(typeof transactions === 'string') {
    transactions = accounts[transactions].trans;
  }
  return transactions.filter(t => t.transdat.getMonth() === month);
}

function sumMonth(account, month) {
  //console.log("sumPeriod: " + account);
  var trans = getTransactionsMonth(account, month);
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

function sortVerifications() {
  verifications.sort( (a,b) => {
    if(a.verdatum > b.verdatum) {
      return 1;
    } else if(a.verdatum < b.verdatum) {
      return -1;
    } else {
      return (a.serie+a.vernr) > (b.serie+b.vernr) ? 1 : -1;
    }
  });
}

function renumberVerificationsFrom(vernr) {
  console.log("renumberVerificationsFrom from vernr: " + vernr);

  var renumVerifications = verifications.filter(v => v.vernr >= vernr);

  renumVerifications.sort( (a,b) => a.vernr - b.vernr);

  if(renumVerifications.some( (e,i,a) => i > 0 ? (a[i].vernr - a[i-1].vernr !== 1) : false) ) {
    console.log("renumber verifications failed, vernr not a complete sequence");
    return false;
  }

  if(!verifications.filter(v => v.vernr >= vernr).every(v => {
    var oldRegid = v.serie + v.vernr;

    if(v.trans.some(t => t.registred !== oldRegid)) {
      console.log("renumber verifications failed, transactions not correctly registred: ", json(v));
      return false;
    }

    v.vernr = vernr++;
    var newRegid = v.serie + v.vernr;

    v.trans.forEach(t => {
	t.registred = newRegid;
    });

    verificationsIndex[newRegid] = v;

    return true;
  })) {
    return false;
  }

  renumVerifications.sort( (a,b) => a.vernr - b.vernr);

  if(renumVerifications.some( (e,i,a) => i > 0 ? (a[i].verdatum < a[i-1].verdatum) : false) ) {
    console.log("verifications verdatum out of order");
    return false;
  }

  console.log("verifications renumbered");

  return true;
}

function sortTransactions() {
  accountsList.forEach(a => {
    a.trans.sort(transactionSortFunction);
  });
}

var basKontoplan = {};
var kontoGrupper = {};
var kontoKlasser = {};

var SRU_koder = [];

function basKontotyp(kontonr) {
  if (kontonr.startsWith("1")) {
    return 'T';
  } else if(kontonr.startsWith("2")) {
    return 'S';
  } else if(kontonr.startsWith("3")) {
    return 'I';
  } else if(kontonr.startsWith("8")) {
    return 'B';
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

function sumAccounts(filter) {
  var sum = zero();
  accountsList.filter(filter).forEach(k => {
    sum = add(sum, k.saldo);
  });
  return sum;
}

function sumAccountsType(type) {
  return sumAccounts( (k) => basKontotyp(k.kontonr) === type );
}

function findSRUcode(account) {

  var match = [];

  for(i = 0; i < SRU_koder.length; i++) {
    if(account.match(SRU_koder[i].rules.include) && (!SRU_koder[i].rules.exclude || !account.match(SRU_koder[i].rules.exclude))) {

      /*
      if(account.startsWith("25") || account.startsWith("26")) {
	console.log("rule matched: " + JSON.stringify(SRU_koder[i]));
	console.log("include: "+ SRU_koder[i].rules.include);
	console.log("exclude: "+ SRU_koder[i].rules.include);
      }
      */
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

function sruFieldCode(code, balance) {
  var parts = code.split(",");
  if(parts.length === 1) {
    return code;
  }

  var sign = balance < 0 ? "-1" : "1";

  return parts.filter(v => v.startsWith(sign + ":"))[0].split(":")[1];
}


function importSRUkoder(filename) {
  var slask = [];

  var saveHush = hushDebug;
  hushDebug = true;

  function parseSRU_Rule(rule) {

    var include = [];
    var exclude = [];
    var matchsign;

    //console.log("parse SRU rule: ", rule);

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

  function addRecord(record) {
    //console.log("adding SRU codes record: ", JSON.stringify(record));

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


  return new Promise( (resolve, reject) => {
    var prevLine = "";

    lineReader(fs.createReadStream(filename, { encoding: 'utf8'}).on('end', () => {
      debug("srukoder done");
      //console.log("slask: ", slask);
      //Object.keys(basKontoplan).forEach(k => console.log(basKontoplan[k].kontonr + ": " + basKontoplan[k].kontonamn));
      hushDebug = saveHush;
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
      addRecord(cols);
    });

  });
}


// Urval:     ■ \u25a0
// Ändring:   |  \u2759"
function importBaskontoplan(filename) {
  var prevLine = "";

  return new Promise( (resolve, reject) => {

    lineReader(fs.createReadStream(filename, { encoding: 'utf8'}).on('end', () => {
      debug("baskontoplan done");
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
	  kontonamn: kontonamn.replace(/\n/g, ' '),
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

/* -account
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
    kontonamn: kontonamn || (basKontoplan[kontonr] && basKontoplan[kontonr].kontonamn) || ("konto " + kontonr),
    kontotyp: kontotyp || basKontotyp(kontonr),
    ib: zero(),
    saldo: zero(),
    trans: [],
  };

  if(accounts[kontonr]) {
    throw ("addAccount failed, " + kontonr + " already exists");
  }

  accounts[kontonr] = account;
  accountsList.push(account);
}

// imported transactions for autobooking
var importedTransactions = [];

// all transactions in registred verifications
var transactions = [];

var transactionsChanged = false;

/* -transactions
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
// used to detect if new verifications has been added
var lastVerificationNumber;

// grundboken
var verifications = [];
var verificationsIndex = {};


/* -verifications
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

function dumpTransactions(kontonr) {
  console.log("dump transactions for %s", kontonr);
  console.log("--------------------");
  accounts[kontonr] && accounts[kontonr].trans && accounts[kontonr].trans.forEach(t => {
    console.log([formatDate(t.transdat), itoa(t.belopp), t.transtext].join(", "));
  });
  console.log("--------------------");
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

	if(type === 'KONTO') {
	  if(accounts[data.kontonr]) {
	    return reject("error reading accounting file, " + obj.kontonr + " already exits");
	  }
	  obj.kontonamn = obj.kontonamn.replace(/\n/g, ' ');
	  obj.trans = [];
	  accounts[obj.kontonr] = obj;
	  accountsList.push(obj);

	  //if(obj.kontonr === '3001') {
	  //  console.log("inside readbook konto: " + JSON.stringify(obj));
	  //}
	} else if(type === 'VER') {

	  obj.verdatum = convertDate(obj.verdatum);
	  obj.regdatum = convertDate(obj.regdatum);

	  appendVerification(obj);

	  if(!obj.serie || !obj.vernr) {
	    return reject("error reading accounting file, verification " + JSON.stringify(obj) + " has no regid");
	  }

	  var regId = obj.serie + obj.vernr;

	  verificationNumber = Math.max(obj.vernr + 1, verificationNumber);

	  obj.trans.forEach(t => {
	    if(t.registred !== regId) {
	      return reject("error reading accounting file, transaction in verification " + JSON.stringify(obj) + " has mismatching regid: %s !== %s", regId, t.registred);
	    }
	    if(!t.transdat) {
	      return reject("error reading accounting file, transaction in verification " + JSON.stringify(obj) + " has no transdat");
	    }

	    t.transdat = convertDate(t.transdat);

	    accounts[t.kontonr].trans.push(t);
	    if(t.kontonr === '2731') {
	      debug("readBook, add: ", JSON.stringify(t));
	    }
	  });
	}
      }
    });

    lr.on('close', () => {
      debug("readbook done");

      if(jsonFile) {
	var data = JSON.parse(fileData);

	if(data.konton) {
	  Object.keys(data.konton).forEach(k => {
	    var konto = data.konton[k];

	    addAccount(k);
/*
	    accounts[k] = Object.assign({
	      kontonr: k,
	      kontonamn: konto.name.replace(/\n/g, ' '),
	      saldo: fromNumber(typeof konto.ib === 'number' ? konto.ib : 0),
	      trans: []
	    }, typeof konto.ib === 'number' ? { ib: fromNumber(konto.ib) } : {});
	    accountsList.push(accounts[k]);
*/
	  });
	}

	if(data.verifikationer) {
	  data.verifikationer.forEach(v => {
	    //addVerification({
	    importVerification({
	      verdatum: new Date(v.datum),
	      vertext: v.beskrivning + "," + v.id,
	      trans: v.trans.map(t => ({
		kontonr: t.konto,
		belopp: t.belopp //fromNumber(t.belopp)
	      }))
	    });
	  });
	}

/*
	accountsList.forEach(k => {
	  if(typeof k.ub === 'number' && k.saldo === 0) {
	    k.saldo = k.ib;
	  }
	});
*/
      }

      validateBook();
      lastVerificationNumber = verificationNumber;

      return resolve();
    });
  });
}

function writeTransactions(filename) {
  var ws = fs.createWriteStream(filename);
  ws.on('finish', () => {
    console.log("all data written");
  });

  transactions.forEach(t => {
    ws.write(JSON.stringify(t) + '\n');
  });

  ws.end();

  return finished(ws);
}

function readTransactions(filename) {

}

function remapTransactions() {

  if(verifications.length === 0) {
    console.log("remapTransactions ignord, no verifications exists");
    return;
  }

  transactions = transactions.map(t => {
    if(t.registred) {
      //console.log("remap registred imported transaction: " + t.registred);
      var ver = verificationsIndex[t.registred];

      if(ver) {
	var mt = ver.trans.find(vt => isTransactionsEqual(vt, t));
	if(mt) {
	  //console.log("found matching transaction, remap");
	  return mt;
	} else {
	  //console.log("remapTransactions matching transaction for \n%s\n not found in\n%s", json(t), JSON.stringify(ver, null, 2));
	}
      }
    }
    return t;
  });
}

function transferBook() {
  var nextYear = accountsList.map(a => Object.assign(
    {
      kontonr: a.kontonr,
      kontonamn: a.kontonamn,
      kontotyp: a.kontotyp,
    },
    isBalanskonto(a.kontonr) ? { ib: a.saldo, saldo: a.saldo } : { saldo: 0},
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
  if(!ver.trans.every(t => {
    sum = add(sum, t.belopp)
    if(!t.transdat instanceof Date) {
      return false;
    }
    return true
  })) {
    console.log("invalid verification, invalid transactions: ", ver.trans);
    return false;
  }

  if(compare(sum, ZERO) !== 0) {
    console.log("trans balance mismatch: " + itoa(sum));
    ver.trans.forEach(t => console.log(itoa(t.belopp)));
    return false;
  }

  return true;
}

function appendVerification(ver) {
  var verId = ver.serie + ver.vernr;
  verifications.push(ver);
  if(verificationsIndex[verId]) {
    console.log("verification %s allready in ledger:\n", verId, JSON.stringify(verificationsIndex[verId]));
    throw("verification allready in ledger:\n"+ verId + " " + JSON.stringify(verificationsIndex[verId]));
  }
  verificationsIndex[verId] = ver;
  if(verifications.length > 1 && verifications.slice(-2,1).verdatum > ver.verdatum) {
    console.log("appendVerification, insert date mismatch: %s, %s", ""+verifications.slice(-2,1).verdatum, ""+ver.verdatum);
    verifications.sort(verificationSortFunction);
  }
}


function addVerification(ver, check) {
  // check if autobalance/motkonto exists

  try {

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
	//console.log("matching transaction found for %s: ", t.kontonr, json(mt));
	return mt;
      } else {
	//debug("matching transaction NOT found: ", json(t));
	return t;
      }
      //var findTransaction(t)
    });

    if(!ver.verdatum) {
      ver.verdatum = ver.trans[0].transdat || (new Date());
    }

    if(!ver.vertext) {
      ver.vertext = (ver.trans.find(t => !!t.transtext) || {}).transtext;
    }

    if(!ver.regdatum) {
      // use current date as regdatum
      ver.regdatum = new Date();
    }

    // check if we passed the date for moms-rapport
    if(options.autoMoms && verifications.length > 0) {

      //console.log("run automoms for datum: ", verifications.slice(-1)[0].verdatum);

      var prevPeriod = dateToMomsPeriod(verifications.slice(-1)[0].verdatum);
      var currPeriod = dateToMomsPeriod(ver.verdatum);
      if(prevPeriod !== currPeriod) {
	console.log("stänger momsperiod: " + prevPeriod);
	momsrapport(prevPeriod);
      }
    }

    ver.serie = verificationSeries;
    ver.vernr = verificationNumber++;

    const verId = ver.serie + ver.vernr;

    ver.trans.forEach(t => {
      t.registred = verId;
      if(!accounts[t.kontonr]) {
	console.log("add account: ", t.kontonr);
	addAccount(t.kontonr);
      }
      if(!t.transdat) {
	t.transdat = ver.verdatum;
      }
      accounts[t.kontonr].saldo = add(accounts[t.kontonr].saldo, t.belopp);
      //console.log("add transactions to account: ", accounts[t.kontonr]);
      accounts[t.kontonr].trans.push(t);
      transactionsChanged = true;
    });
    appendVerification(ver);

    return ver;
  } catch(e) {
    console.log("Failed to add verification:\n", JSON.stringify(ver, null, 2));
    console.log("error: ", e);
    throw e;
  }
}

function printVerification(ver) {
  console.log("regid: " + ver.serie + ver.vernr);
  console.log("verdatum: " + formatDate(ver.verdatum));
  console.log("vertext: " + ver.vertext);
  console.log("------------------------------------");
  printTable(ver.trans);
  return ver;
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
    if(t.transtext) {
      ret.transtext = t.transtext;
    }
    return ret;
  });

  if(!ver.vertext) {
    ver.vertext = (ver.trans.find(t => !!t.transtext) || {}).transtext;
  }

  // check if verification is within current financial year, or specified endDate for autobooking
  if(ver.verdatum >= startDate && ver.verdatum <= (options.autobookEndDate || endDate)) {

    if(verifications.filter(v => Math.abs(v.verdatum.getTime()-ver.verdatum.getTime()) < 24*3600*1000).some(v => {
      if(formatDate(v.verdatum, "") === formatDate(ver.verdatum, "")) {
	// same date
	if(v.vertext === ver.vertext) {
	  // check if all transactions match, unless belopp is 0 (motkonto)
	  if(ver.trans.every(t => {
	    if(iszero(t.belopp)) {
	      return true;
	    }
	    return v.trans.some(vt => isTransactionsSimilar(vt,t));
	  })) {
	    return true;
	  }
	}
      }
      return false;
    })) {
      debug("ignore import verificaion, allready in book: ", json(ver))
    } else {
      debug("import, add verification: ", json(ver));
      addVerification(ver);
    }
  }
  return ver;
}

function importYamlVerificationFile(filename) {
  debug("read yaml file: " + filename);
  var p = readFileUTF8(filename).then( yaml => {
    debug("readFileUTF8 done");
    var data = YAML.parseAllDocuments(yaml);
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
  debug("import unbooked verifications from: %s", options.verifications);
  debug("last verification in book: " + verifications.reduce( (a, v) => v.vernr > a ? v.vernr : a, 0));
  debug("next verificationNumber: " + verificationNumber);

  return new Promise( async (resolve,reject) => {
    var files = await fsp.readdir(options.verifications);
    debug("importVerifications got files: ", files);
    for (const f of files) {
      if(!f.startsWith('.#') && f.endsWith(".yaml")) {
	debug("import verification file: " + f);
	await importYamlVerificationFile([options.verifications,f].join('/'));
	debug("importVerifications, yaml file imported");
      }
    }
    console.log("import verifications done");
    return resolve();
  });

}

function matchTransaction(t, reg, kontonr, belopp) {
  //var m = [ (!reg || !!t.transtext.match(reg)) , (!kontonr || t.kontonr === kontonr) , (!belopp || t.belopp === belopp) ];
  //console.log("matcher: ", m, JSON.stringify(t));

  return (!reg || t.transtext.match(reg)) && (!kontonr || t.kontonr === kontonr) && (!belopp || t.belopp === belopp);
}

function filterTransactions(text, kontonr, belopp, dateFrom, dateTo) {
  debug("filterTransactions called, [%s], [%s], [%s], [%s], [%s]", ""+text, kontonr, itoa(belopp), ""+dateFrom, ""+dateTo);

  var matchfunc;

  if(!text) {
    matchfunc = function() { return true; };
  } else {
    matchfunc = (typeof text === 'string') ?
      function strmatcher(str) { return str === text } :
      function regmatcher(str) { return str && str.match(text) };
  }

  var res = transactions.filter(t => {
/*
    if(t.kontonr === kontonr) {
      debug("TRANS: " + json(t));
      debug("matcher: text: %s, belopp: %s, daterange: %s", !!matchfunc(t.transtext), !!equal(t.belopp, belopp), !!dateRange(t.transdat, dateFrom, dateTo) );
    }
*/
    return matchfunc(t.transtext) && equal(t.belopp, belopp) && t.kontonr === kontonr && dateRange(t.transdat, dateFrom, dateTo);
  });
  return res;
}

function findTransaction(match, kontonr, belopp, dateFrom, dateTo) {
  var res = filterTransactions(match, kontonr, belopp, dateFrom, dateTo);

  if(res && res.length == 1) {
      return res[0];
  } else {
    //console.log("res matched: ", res);
    return false;
  }
}

// only returns verification if the matching verification is unique
function findVerification(text, kontonr, dateFrom, dateTo) {
  var matchfunc = (typeof text === 'string') ?
      function strmatcher(str) { return str === text } :
      function regmatcher(str) { return str && str.match(text) };


  var res;
  if(kontonr) {

    if(!accounts[kontonr]) {
      debug("findVerification, no transactions for " + kontonr);
      return false;
    }
    res = accounts[kontonr].trans.map(t => verificationsIndex[t.registred]).filter(v => { /*console.log("match v: ", v); */ return matchfunc(v.vertext); });
  } else {
    res = verifications.filter(v => matchfunc(v.vertext));
  }

  return res.length === 1 ? res[0] : false;
}

////////////////////////////////////////
//
// autobook: Automatically book transactions into verifications

//function pensionTrans(belopp) {
//}

function autobook(t) {
  if(matchTransaction(t, /^SEB pension/, "1930", fromNumber(-1000)) || matchTransaction(t, /^SEB pension/, "1930", fromNumber(-20000))) {
    //console.log("autobook SEB pension" + JSON.stringify(t));
    addVerification({ trans: [ t, trans("7412", neg(t.belopp)),
				      trans("2514", muldiv(t.belopp, skattesatser.särskildlöneskatt, 10000)),
				      trans("7533", muldiv(neg(t.belopp), skattesatser.särskildlöneskatt, 10000))]});
  } else if(matchTransaction(t, /Länsförsäkr/, "1930", fromNumber(-11099))) {
    let pension = fromNumber(10900.46);
    let forman = fromNumber(198.21);
    addVerification({ trans: [ t, trans("7412", pension),
			       trans("2514", muldiv(neg(pension), skattesatser.särskildlöneskatt, 10000)),
			       trans("7533", muldiv(pension, skattesatser.särskildlöneskatt, 10000)),
			       trans("7389", forman),
			       trans("2731", muldiv(neg(forman), skattesatser.arbetsgivaravgift, 10000)),
			       trans("7512", muldiv(forman, skattesatser.arbetsgivaravgift, 10000)),
			       trans("3740", fromNumber(0.33))
			     ]});
  } else if(matchTransaction(t, /Länsförsäkr/, "1930", fromNumber(-11167))) {
    let pension = fromNumber(10952.58);
    let forman = fromNumber(214.02);
    addVerification({ trans: [ t, trans("7412", pension),
			       trans("2514", muldiv(neg(pension), skattesatser.särskildlöneskatt, 10000)),
			       trans("7533", muldiv(pension, skattesatser.särskildlöneskatt, 10000)),
			       trans("7389", forman),
			       trans("2731", muldiv(neg(forman), skattesatser.arbetsgivaravgift, 10000)),
			       trans("7512", muldiv(forman, skattesatser.arbetsgivaravgift, 10000)),
			       trans("3740", fromNumber(0.40))
			     ]});
  } else if(matchTransaction(t, /Länsförsäkr/, "1930", fromNumber(-11239))) {
    let pension = fromNumber(11009.54);
    let forman = fromNumber(229.50);
    addVerification({ trans: [ t, trans("7412", pension),
			       trans("2514", muldiv(neg(pension), skattesatser.särskildlöneskatt, 10000)),
			       trans("7533", muldiv(pension, skattesatser.särskildlöneskatt, 10000)),
			       trans("7389", forman),
			       trans("2731", muldiv(neg(forman), skattesatser.arbetsgivaravgift, 10000)),
			       trans("7512", muldiv(forman, skattesatser.arbetsgivaravgift, 10000)),
			       trans("3740", fromNumber(-0.04))
			     ]});
  } else if(matchTransaction(t, /Länsförsäkr/, "1930", fromNumber(-11305))) {
    let pension = fromNumber(11056.20);
    let forman = fromNumber(249.02);
    addVerification({ trans: [ t, trans("7412", pension),
			       trans("2514", muldiv(neg(pension), skattesatser.särskildlöneskatt, 10000)),
			       trans("7533", muldiv(pension, skattesatser.särskildlöneskatt, 10000)),
			       trans("7389", forman),
			       trans("2731", muldiv(neg(forman), skattesatser.arbetsgivaravgift, 10000)),
			       trans("7512", muldiv(forman, skattesatser.arbetsgivaravgift, 10000)),
			       trans("3740", fromNumber(-0.22))
			     ]});
  } else if(matchTransaction(t, /Banktjänster/, "1930", fromNumber(-100))) {
    addVerification({ trans: [ t, motkonto("6570")]});
  } else if(matchTransaction(t, /Banktjänster/, "1930", fromNumber(-102))) {
    addVerification({ trans: [ t, motkonto("6570")]});
  } else if(matchTransaction(t, /Debiterad preliminärskatt/, "1630")) {
    addVerification({ trans: [ t, motkonto("2518")]});
  } else if(matchTransaction(t, /Arbetsgivaravgift/, "1630")) {
//    console.log("arbetsgivaravgift dragen: %s", formatDate(t.transdat));
    var saldoPeriod = saldo("2731", addDays(t.transdat, -t.transdat.getDate()));
    var inbetalt = t.belopp;
    var diff = abs(sub(saldoPeriod, inbetalt));
/*
    console.log("periodsaldo: %s, inbetalt: %s", itoa(saldoPeriod), itoa(inbetalt));
    console.log("öresdiff: ", itoa(sub(saldoPeriod, inbetalt)));
    console.log("compare: %s - %s, %d", diff, fromNumber(1.0), compare(diff, fromNumber(1.0)));
*/
    if(compare(diff, fromNumber(1.0)) < 1) {
//      console.log("avrunda: ", itoa(sub(saldoPeriod, inbetalt)));
      addVerification({ trans: [ t, trans("2731", neg(saldoPeriod)), motkonto("3740")]});
    } else {
      addVerification({ trans: [ t, motkonto("2731")]});
    }
  } else if(matchTransaction(t, /Avdragen skatt/, "1630")) {
    addVerification({ trans: [ t, motkonto("2710")]});
  } else if(matchTransaction(t, /Moms/, "1630")) {
    addVerification({ trans: [ t, motkonto("2650")]});
  } else if(matchTransaction(t, /855-4546633/, "1930") || matchTransaction(t, /8554546633/, "1930")) {
    var ver = addVerification({ trans: [ t,
			       trans("6540", neg(t.belopp)),
			       trans("4531", neg(t.belopp)),
			       trans("4599", t.belopp),
			       trans("2614", muldiv(t.belopp, skattesatser.moms, 10000)),
			       trans("2645", neg(muldiv(t.belopp, skattesatser.moms, 10000))),
				       ]}, true);

/*
    var dup = new Set();
    ver.trans.forEach(t => (dup.has(t) && console.log("DUPLICATE: ", t)) || (dup.add(t)) );


    console.log("added verification: " + (verificationNumber - 1), ver.serie+ver.vernr);
    ver.trans.forEach(t => console.log(json(t)));

    console.log("ARRAY: ", [ t,
			       trans("6540", neg(t.belopp)),
			       trans("4531", neg(t.belopp)),
			       trans("4599", t.belopp),
			       trans("2614", muldiv(t.belopp, skattesatser.moms, 10000)),
			       trans("2645", neg(muldiv(t.belopp, skattesatser.moms, 10000))),
			   ]);

    console.log("ARRAY2: ", ver.trans);
*/

  } else if(matchTransaction(t, /Utdelning/, "1930")) {
    addVerification({ trans: [ t, motkonto("2898")]});
  } else if(matchTransaction(t, /Skatteverket/, "1930")) {
    let ts = findTransaction(/Inbetalning bokförd/, "1630", neg(t.belopp), t.transdat, addDays(t.transdat, 3));
    if(ts) {
      //console.log("Inbetalning bokförd, found matching transation: " + JSON.stringify(ts));
      addVerification({ trans: [ t, ts ]});
    }
  }
}

function autobookTransactions() {
  console.log("run autobook on unbooked transactions: ", transactions.filter(t => !t.registred).length);
  var numBooked = 0;
  transactions.forEach(t => {
    // only autobook unregistred transacions within end date/specified endDate
    if(!t.registred && t.transdat <= (options.autobookEndDate || endDate) ) {
      debug("autobook: ", json(t));
      var ver = autobook(t);
      if(ver) {
	numBooked++;
	debug("autobooked: ", ver);
      }
    }
  });
  console.log("autobook done, remaining unbooked transactions: "  + transactions.filter(t => !t.registred).length);
}

var momsRapportMall = [
  [ "3001", "5" , -1], // I-Försäljning 25%
  [ "2610", "10", -1], // S-Utgående Moms 25%
  [ "4515", "20",  1], // K+Inköp varor EU 25 %
  [ "4531", "22",  1], // K+Tjänst. Utanf. EU  25 %
  [ "2614", "30", -1], // S-Utgåend moms Omv skatt 25%
  [ "4545", "50",  1], // K+Import varor 25%
  [ "2615", "60", -1], // S-Utgående moms varuimport 25 %
  [ "2640", "0",    1],   // S+Ingående Moms
  [ "2645", "0",    1]];  // S+Ingående moms Utland

function momsRapportPeriod(period) {
  var from = new Date(startDate);
  from.setMonth(from.getMonth()+(period-1)*3);
  var to = new Date(from);
  to.setMonth(to.getMonth()+3);
  to.setDate(to.getDate()-1);

  debug("periodSlut: " + to);
  debug("period: ", from.getMonth(), to.getMonth());
  return {
    from: from,
    to: to
  };
}

function periodText(range) {
  return  month[range.from.getMonth()] + " - " + month[range.to.getMonth()];
}

function dateToMomsPeriod(date) {
  // quick and dirty

  var log = "";

  var period = 1;
  var numPeriods = 12 / options.momsperiod;
  while(period <= numPeriods) {
    var d = momsRapportPeriod(period);

    log+= `testing ${date} against momsperiod: ${json(d)}\n`;

    //if(date >= d.from && date <= d.to) {
    if(dateInRange(date, d)) {
      return period;
    }
    period++;
  }

  console.log("did not find date in momsperioder: ", log);

  throw(`dateToMomsPeriod, ${date} not in fiscal year: ${finansialYearString}`);
}

function momsdeklaration(period) {
  var momsPeriod = momsRapportPeriod(period);

  console.log("momsdeklaration för " + periodText(momsPeriod));

  // check if an existing verification for this period has been booked
  var vertext = "momsrapport " + momsPeriod.periodText;

  var momsVerifikation = findVerification(vertext, "2650")  || findVerification(vertext, "1650");
  var momsVerRegid = (momsVerifikation && (momsVerifikation.serie + momsVerifikation.vernr)) || "";

  function sumMomsBelopp(account) {
    var trans = getTransactionsPeriod(account, period).filter(t => t.registred !== momsVerRegid);
    //console.log("moms belopp trans: ", trans);
    return sumTransactions(trans);
  }

    var rapport = momsRapportMall.map(m => ({
      fältnamn: accounts[m[0]].kontonamn.replace("\n"," "),
      fältkod: m[1],
      belopp: floor(sumMomsBelopp(m[0], period))
    }));

    //rapport.filter(r => r.fältkod === "0").forEach(i => console.log("ing: ", i));

    var ingMoms = rapport.filter(r => r.fältkod === "0").reduce( (a,v) => add(a, v.belopp), zero());

    debug("ingående moms: " + ingMoms);

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


    // adjust sign for accounts with negative balance
    rapport.forEach( (r,i) => (r.belopp = itoa( (momsRapportMall[i] && momsRapportMall[i][2]) < 0 ? neg(r.belopp ): r.belopp)));
  return rapport;
}

function momsrapport(period) {
  console.log("bokföring av momsrapport för period " + period);

/*
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
*/
  var rapport = momsRapportMall.map(m => ({
    konto: m[0],
    belopp: sumPeriod(m[0], period)
  }));

  var kontoMap = rapport.reduce( (a,v) => (a[v.konto] = v, a), {});

  console.log("Ingående moms: ", itoa(kontoMap["2640"].belopp));

  var from = new Date(startDate);
  from.setMonth(from.getMonth()+(period-1)*3);
  var to = new Date(from);
  to.setMonth(to.getMonth()+3);
  to.setDate(to.getDate()-1);
  console.log("periodSlut: " + to);

  var ver = {
    verdatum: new Date(formatDate(to)),
    vertext: "momsrapport " + month[from.getMonth()] + " - " + month[to.getMonth()],
    trans: []
  };

  var ing = zero();
  ing = add(ing, floor(kontoMap["2640"].belopp));
  ing = add(ing, floor(kontoMap["2645"].belopp));

  var utg = zero();
  utg = add(utg, floor(kontoMap["2610"].belopp));
  utg = add(utg, floor(kontoMap["2614"].belopp));
  utg = add(utg, floor(kontoMap["2615"].belopp));

  console.log("momsrapport ing: ", itoa(ing), ", utg: ", itoa(utg));

  var summa = zero();
  var summa = add(summa, ing)
  var summa = add(summa, utg);;

  function addAccount(konto) {
    if(!iszero(kontoMap[konto].belopp)) {
      ver.trans.push(trans(konto, neg(kontoMap[konto].belopp)));
    }
  }

  addAccount("2610");
  addAccount("2614");
  addAccount("2615");
  addAccount("2640");
  addAccount("2645");

  if(isneg(summa)) {
    // momsskuld
    ver.trans.push(trans("2650", summa));
  } else {
    // momsfodran
    ver.trans.push(trans("1650", neg(summa)));
  }
  ver.trans.push(motkonto("3740"));
  console.log("\n\nverifikation momsrapport:\n");
  console.log("DUMP:\n", JSON.stringify(printVerification(addVerification(ver)), null, 2));
}

function dumpUnbookedTransactions() {
  transactions.forEach(t => {
    if(!t.registred) {
      console.log(YAML.stringify({
	verdatum: formatDate(t.transdat, "-"),
	trans: [Object.assign({}, t, { belopp: 1*itoa(t.belopp) }) ]
      }) + '\n...\n');
    }
  });
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
  testDateCompare: function (a, b) {
    console.log(dateCompare(new Date(a), new Date(b)));
  },
  testmomsp: function() {
    var nump = 12/options.momsperiod;
    for(var i = 0; i < 200000; i++) {
      var p = 1+nump*Math.random()|0;
      var d = momsRapportPeriod(p);

      var secs = (d.periodSlut - d.periodStart) / 1000;
      var days = 1+(secs / 86400)|0;
      var hours = secs / 3600;

      var testDate = addDays(d.periodStart, days*Math.random()|0);

      var cp = dateToMomsPeriod(testDate);

      if(cp !== p) {
	console.log("failed, p: " + p, ", calc: ", cp, ""+testDate);
      }
    }
  },
  testperiod: function (period) {
    //console.log("testperiod: ", period);
    var trans = getTransactionsPeriod(transactions, 1*period);
    //console.log("got trans: ", trans);
    printTable(trans.map(t => {
      t = Object.assign({}, t);
      t.transdat = "    "+formatDate(t.transdat);
      t.belopp = ("            "+itoa(t.belopp)).slice(-12);
      t.transtext = "    " + t.transtext;
      return t;
    }));
  },
  testsum: function() {
    var args = Array.prototype.slice.call(arguments);
    console.log("sum array: ", args);
    args = args.map(a => {
      if(typeof a === 'string') {
	console.log("atoi: %s ", a, atoi(a));
	return atoi(a);
      } else {
	return fromNumber(a);
      }
    });
    console.log("mapped args: ", args);
    console.log("sum: ", itoa(sum.apply(this, args)));
  },
  prevmonth: function(date) {
    date = (date && new Date(date)) || new Date();

    var prev = addDays(date, -date.getDate());

    console.log("%s -> %s", formatDate(date), formatDate(prev));
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
  srukoder: function(filename) {
    importSRUkoder(filename || options.srukoder).then( (res) => {

      SRU_koder.forEach(s => {
	console.log("SRU: " + JSON.stringify(s));
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
	    console.log("SRU code for ", konto, srukod, " matches: ", res.srukod, (srukod !== res.srukod) ? "FEL!!!" : ""); //, JSON.stringify(res));
	  } else {
	    console.log("SRU code for KONTO: ", konto, "SRU: ", srukod, " NOMATCH");
	  }
	}
      });

      console.log("test SRU code for 1510: ", findSRUcode("1510"));
      console.log("test SRU code for 1930: ", findSRUcode("1930"));
    });

  },
  cleartransactions: function() {
    var numCleared = 0;
    transactions.forEach(t => {
      if(t.registred) {
	numCleared++;
	delete t.registred;
      }
    });
    if(numCleared > 0) {
      transactionsChanged = true;
      console.log("registred borttaget från %d transaktioner", numCleared);
    }
  },
  marktransactions: function(force) {
    var numMarked = 0;

    transactions.every(t => {
      if(force || !t.registred) {
	console.log("mark transaction: ", json(t));
	//var mt = accounts[t.kontonr].trans.find(mt => isTransactionsEqual(t, mt));

	var mts = accounts[t.kontonr].trans.filter(mt => {
	  if(t.transtext === "Inbetalning bokförd 190708") {
	    console.log("similar %s, %s", json(t), json(mt));
	  }
	  return isTransactionsSimilar(t, mt);
	});

	if(mts.length !== 1) {
	  console.log("not found:  ", mts);
	  return false;
	}

	console.log("found in verification: " + mts[0].registred);
	t.registred = mts[0].registred;
	transactionsChanged = true;
	if(t.transtext && !mts[0].transtext) {
	  mts[0].transtext = t.transtext;
	}

	if(mts[0].transdat !== t.transdat) {
	  mts[0].transdat = t.transdat;
	}

	numMarked++;
	return true;
      } else {
	console.log("transaction registred: ", json(t));
	return true;
      }
    });
    console.log("num transactions: " + transactions.length);
    console.log("num marked: " + numMarked);
    remapTransactions();
  },
  autobook: async function() {
  },
  awaitWrite: async function(filename) {
    console.log("await write transactions");
    await writeTransactions(filename);
    console.log("writeTransactions finished");
  },


  ver: function(regid) {
    var ver = verificationsIndex[regid];

    if(ver) {
      //console.log(YAML.stringify(ver.trans));
      //console.log(json(ver));
      //ver.trans.forEach(t => {
      //console.log(json(t));
      //});
      printVerification(ver);
    }

  },
  trans: function(kontonr) {
    console.log("konto: %s", kontonr);
    console.log("IB: %s", itoa(accounts[kontonr].ib));
    var table = [];
    console.log("--------------------");
    accounts[kontonr].trans.forEach(t => {
      //console.log("add transaction: ", t);
      table.push({ datum: formatDate(t.transdat), belopp: formatNumber(t.belopp, 10), beskrivning: t.transtext || (verificationsIndex[t.registred] || {}).vertext, regid: t.registred });
    });
    table.length > 0 && printTable(table);
    console.log("--------------------");
    console.log("UB: %s", itoa(accounts[kontonr].saldo));
  },
  findtrans: function(text, kontonr, belopp, dateFrom, dateTo) {
    //var trans = findTransaction(reg, kontonr, belopp, dateFrom, dateTo);
    enableDebug();
    var m;
    if( (m=text.match(/\/(.*)\//))) {
      text = new RegExp(m[1]);
    }

    var trans = findTransaction(text, kontonr, fromNumber(1*belopp), new Date(dateFrom), new Date(dateTo));
    disableDebug();
    if(trans) {
      console.log("Found transaction: %s\%s", json(trans), YAML.stringify(trans));
    } else {
      console.log("transaction not found");
    }
  },
  sum: function(kontonr, from, to) {
    var trans = (accounts[kontonr] && accounts[kontonr].trans.filter(t => dateRange(t.transdat, from && new Date(from), to && new Date(to)))) || [];

    console.log(kontonr);
    console.log("----------");
    trans.forEach(t => console.log(formatNumber(t.belopp, 10), formatDate(t.transdat), pad(t.registred, 4), t.transtext || verificationsIndex[t.registred].vertext || verificationsIndex[t.registred].vertext || "..."));
    console.log("----------");
    console.log(formatNumber(sumTransactions(trans), 10));

  },

  saldo: function(kontonr, date) {
    date = new Date(date || Date.now());
    console.log(kontonr);
    console.log("-------");
    console.log(formatNumber(accounts[kontonr].ib || ZERO, 10), formatDate(startDate), "Ingående balans");
    accounts[kontonr] && accounts[kontonr].trans.filter(t => dateRange(t.transdat, false, date)).forEach(t => console.log(formatNumber(t.belopp, 10), formatDate(t.transdat), pad(t.registred, 4), t.transtext || verificationsIndex[t.registred].vertext || "..."));
    console.log("-------");
    console.log(formatNumber(saldo(kontonr, date), 10));

  //console.log(formatNumber( add( accounts[kontonr].ib ,sumTransactions(accounts[kontonr].trans.filter(t => {
    //  return dateRange(t.transdat, false, date)
    //}))), 10));
  },
  konto: function(kontonr) {
    var info = basKontoplan[kontonr];
    if(info) {
      console.log("konto: %s", kontonr);
      console.log("kontonamn: " + info.kontonamn);
      console.log("Kontotyp: " + basKontotyp(kontonr));
    }
    var sru = findSRUcode(kontonr);
    if(sru) {
      console.log("srukod: " + sru.srukod);
      console.log("beskrivning: " + sru.name);
    }
  },

  arbetsgivaravgifter: function(month) {

    if(typeof month === 'undefined') {
      month = (new Date()).getMonth() - 1;
    }

    var objekt = [];

    var rapportMall = [
      ["7211", 2, 'lön'],
      ["7221", 1, 'lön'],
      ["7389", 1, 'förmåner'],
      ["7511", 0, 'arbetsgivaravgift'],
      ["7512", 0, 'arbetsgivaravgift'],
    ];
    rapportMall.forEach(r => {
      var k = r[0];
      var id = r[1];
      var field = r[2];

      var o = objekt[id];
      if(!o) {
	o = objekt[id] = {};
      }

      if(typeof o[field] === 'undefined') {
	o[field] = 0;
      }

      var sum;

      if(field === 'lön') {
	var trans = getTransactionsMonth(k, month);
	trans.forEach(t => {
	  var ver = verificationsIndex[t.registred];
	  ver.trans.forEach(vt => {
	    if(vt.kontonr === t.kontonr) {
	      o[field] += vt.belopp;
	    }

	    if(vt.kontonr === "2710") {
	      o['personalskatt'] = (o['personalskatt'] || 0) - vt.belopp;
	    }

	  });
	});
      } else {
	o[field] += sumMonth(k, month)
      }

//      objekt[o] = objekt[o] || {};
//      objekt[o][t] = (objekt[o][t] || 0) + sum;
    });



    objekt.sort();

    console.log(json(objekt));

    objekt.forEach( (o,i) => {
      console.log("\nindividuppgifter för " + i + "\n------------------------------");
      Object.keys(o).forEach( k => {
	console.log((k + ":                    ").slice(0,20), itoa(o[k]));
      });
    });

    console.log("");

    //console.log(k, itoa(sum), accounts[k].kontonamn);

  },
  momsdeklaration: function(period) {
    console.log("momsdeklaration för period " + period);
    var rapport = momsdeklaration(period);
    printTable(rapport);

  },
  momsrapport: function(period) {
    momsrapport(period);
  },
  balans: function () {
    console.log("Tillgångar:");
    var sum = zero();

    var rapport = [];

    accountsList.filter(k => basKontotyp(k.kontonr) === 'T').forEach(k => {

      //if(k.kontonr === '1730') {
      //console.log("balans konto: " + JSON.stringify(k));
      //}

      rapport.push({kontonr: k.kontonr, kontonamn: k.kontonamn, saldo: formatNumber(k.saldo, 10)});
      sum = add(sum, k.saldo);
    });
    printTable(rapport);
    console.log("\ntillgångar");
    console.log("------------------------------------------");
    console.log("summa: " + itoa(sum));

    rapport = [];

    sum = 0;
    accountsList.filter(k => basKontotyp(k.kontonr) === 'S').forEach(k => {
      rapport.push({kontonr: k.kontonr, kontonamn: k.kontonamn, saldo: formatNumber(k.saldo, 10)});
      sum = add(sum, k.saldo);
    });
    console.log("\nskulder");
    printTable(rapport);
    console.log("------------------------------------------");
    console.log("summa: " + itoa(sum));

  },
  resultat: function() {
    console.log("Intäkter:");
    var intäkter = zero();

    var rapport = [];

    accountsList.filter(k => basKontotyp(k.kontonr) === 'I').forEach(k => {
      rapport.push({kontonr: k.kontonr, kontonamn: k.kontonamn, saldo: itoa(k.saldo)});
      intäkter = add(intäkter, k.saldo);
    });
    printTable(rapport);
    console.log("\nIntäkter");
    console.log("------------------------------------------");
    console.log("summa: " + itoa(intäkter));

    rapport = [];

    var kostnader = zero();
    accountsList.filter(k => basKontotyp(k.kontonr) === 'K').forEach(k => {
      rapport.push({kontonr: k.kontonr, kontonamn: k.kontonamn, saldo: itoa(k.saldo)});
      kostnader = add(kostnader, k.saldo);
    });
    console.log("\nkostnader");
    printTable(rapport);
    console.log("------------------------------------------");
    console.log("summa: " + itoa(kostnader));

    // TODO adjust for non deductible costs

    var resultat = neg(add(kostnader, intäkter));
    console.log("\nResultat före skatt: " + itoa(resultat));
    var skatt = floor(muldiv(mul(fromNumber(10),div(resultat, fromNumber(10))), skattesatser.bolagsskatt, 10000));

    rapport = [];

    var bokfposter = zero();
    accountsList.filter(k => basKontotyp(k.kontonr) === 'B').forEach(k => {
      rapport.push({kontonr: k.kontonr, kontonamn: k.kontonamn, saldo: itoa(k.saldo)});
      bokfposter = add(bokfposter, k.saldo);
    });

    console.log("\nfinansiella poster och bokförings dispositioner");
    printTable(rapport);
    console.log("------------------------------------------");
    console.log("summa: " + itoa(bokfposter));

    console.log("\nSkatt på årets resultat: " + itoa(skatt));


  },
  bokslut: function () {
    var resultat = neg(add(sumAccountsType('K'), sumAccountsType('I') ));
    var skatt = floor(muldiv(mul(fromNumber(10),div(resultat, fromNumber(10))), skattesatser.bolagsskatt, 10000));
    console.log("Resultat före skatt: " + itoa(resultat));
    console.log("Skatt på årets resultat: " + itoa(skatt));
    var bokslutsdisp = sumAccountsType('B');
    console.log("Bokslutsdispositioner: " + itoa(bokslutsdisp));
    var åretsresultat = sub(sub(resultat, skatt), bokslutsdisp);
    console.log("Årets resultat: " + itoa(åretsresultat));

    // crude hack, set verdatum as string
    addVerification({ verdatum: new Date(formatDate(endPrintDate)) ,vertext: "Årets resultat", trans: [ trans("8999", åretsresultat), trans("2099", neg(åretsresultat)) ] });
    addVerification({ verdatum: new Date(formatDate(endPrintDate)), vertext: "Skatt på årets resultat", trans: [ trans("8910", skatt), trans("2512", neg(skatt)) ] });
  },
  arsredovisning: function () {
//    var intäkter = zero();

    var resultatmall = [{
      rubrik: "Nettoomsättning",
      fields: "7410",
    },{
      rubrik: "Personalkostnader",
      fields: "7514",
    },{
      rubrik: "Av- och nedskrivningar av materiella och immateriella anläggningstillgångar",
      fields: "7515",
    },			{
      rubrik: "Övriga kostnader",
      fields: "7511,7513",
    },{
      rubrik: "Rörelseresultat",
      fields: "7410,7514,7511,7513,7515",
    },{
      rubrik: "Finansiella poster",
      fields: "7522",
    },{
      rubrik: "Resultat efter finansiella poster",
      fields: "7410,7514,7511,7513,7515,7522",
    },{
      rubrik: "Summa bokslutsdispositioner",
      fields: "7524,7419,7420,7525,7421,7526,7422,7527",
    },{
      rubrik: "Resultat före skatt",
      fields: "7410,7514,7511,7513,7515,7522,7524,7419,7420,7525,7421,7526,7422,7527",
    },{
      rubrik: "Skatt på årets resultat",
      fields: "7528",
    },{
      rubrik: "Årets resultat",
      fields: "7410,7514,7511,7513,7515,7522,7524,7419,7420,7525,7421,7526,7422,7527,7528",
    }];


    var balansmall = [
      {
	rubrik: "Materiella anläggningstillgångar",
	fields: "7214,7215,7216,7217",
      },{
	rubrik: "Kundfordringar",
	fields: "7251",
      },{
	rubrik: "Övriga fordringar",
	fields: "7261"
      },{
	rubrik: "Kassa och bank",
	fields: "7281",
      },{
	rubrik: "Förutbetalda kostnader och upplupna intäkter",
	fields: "7263",
      },{
	rubrik: "Bundet eget kapital",
	fields: "7301",
      },{
	rubrik: "Balanserat resultat",
	fields: "7302,7450",
      },{
	rubrik: "Årets resultat",
	fields: "7450",
      },{
	rubrik: "Kortfristiga skulder",
	fields: "7368,7369",
      }
    ];

    var sammanställning = [];
    var redovisning = {};

    function adderaPoster(typ) {
      accountsList.filter(k => basKontotyp(k.kontonr) === typ).filter(k => !iszero(k.saldo)).forEach(k => {
	var sru = findSRUcode(k.kontonr);
	if(sru) {
	  var field = sruFieldCode(sru.srukod, k.saldo);
	  var post = redovisning[field] || (redovisning[field] = { srukod: field, saldo: zero(), namn: sru.name, konton: [] });

	  console.log("add typ %s, konto: %s, belopp: %s", typ, k.kontonr, itoa(k.saldo));

	  //if(k.kontonr

	  post.saldo = add(post.saldo, k.saldo);
	  post.konton.push(k.kontonr);
	}

	//      rapport.push({kontonr: k.kontonr, kontonamn: k.kontonamn, saldo: itoa(k.saldo)});
	//intäkter = add(intäkter, k.saldo);
      });
    }
    adderaPoster('I');
    adderaPoster('K');
    adderaPoster('T');
    adderaPoster('S');

    //Object.keys(redovisning).forEach(k => console.log(k, redovisning[k]));

    var resultat = zero();

    console.log("----------------------------------------");
    console.log("RESULTATRÄKNING\n");
    resultatmall.forEach(m => {
      var summa  = zero();

      m.fields.split(",").filter(f => !!redovisning[f]).forEach(f => {
	summa = add(summa, redovisning[f].saldo);
	redovisning[f].used = true;
      });

      summa = neg(summa);

      console.log(m.rubrik + ": " + itoa(summa));
    });

    console.log("----------------------------------------");
    console.log("BALANSRÄKNING\n");
    balansmall.forEach(m => {
      var summa  = zero();

      m.fields.split(",").filter(f => !!redovisning[f]).forEach(f => {
	summa = add(summa, redovisning[f].saldo);
	redovisning[f].used = true;
      });

      //summa = neg(summa);

      console.log(m.rubrik + ": " + itoa(summa));
    });


    //console.log("unmapped fields");
    printTable(Object.keys(redovisning).map(k => redovisning[k]).filter(r => !r.used).map(r => ({ srukod: r.srukod, belopp: r.saldo, namn: r.namn, konton: r.konton.join(",")})));
  },
  deklaration: function() {

    function fieldCode(code, balance) {
      var parts = code.split(",");
      if(parts.length === 1) {
	return code;
      }

      var sign = balance < 0 ? "-1" : "1";

      return parts.filter(v => v.startsWith(sign + ":"))[0].split(":")[1];
    }


    var kontoMap = accountsList.slice(0).sort( (a,b) => { return (1*a.kontonr - 1*b.kontonr); } );

    kontoMap.forEach(k => {
      k.sru = findSRUcode(k.kontonr);

      if(!k.sru) {
	console.log("sru kod for account: " + k.kontonr + ", not found");
      }
    });

    var ink2r = kontoMap.reduce( (a,v,i) => {
      //  console.log("Check index: ", i, v);

      if(!i || a[a.length-1].sru.srukod !== v.sru.srukod) {
	a.push(Object.assign({},v));
      } else {
	a[a.length-1].saldo = add(a[a.length-1].saldo, v.saldo);
	a[a.length-1].konto +="," + v.kontonr
      }
      return a;
    },[]).map(v => {v.srukod = fieldCode(v.sru.srukod, v.saldo); return v; });

    var konton = kontoMap.reduce( (a,v) => { a[v.kontonr] = v; return a; }, {});

    var sruCodes = {
      "4.1":  "7650",
      "4.3a": "7651",
      "4.3c": "7653",
      "4.15": "7670"
    };

    function sruCode(code) {
      return sruCodes[code];
    }

    function addField(code, accountList) {
      var sum = accountList.split(",").reduce( (a,v) => add(a,accounts[v].saldo), zero());

      return { srukod: sruCode(code), saldo: sum };
    }

    var ink2s = [
      addField("4.1", "8999"),
      addField("4.3a", "8910"),
      addField("4.3c", "8423,6072"),
      addField("4.15", "8999,8910,8423,6072")
    ];


    function generateInfo() {

      var bolagsnamn = options.bolagsnamn || "Demobolag AB";

      var orgnr = options.orgnummer || "191010101010";
      var postnr = options.postnr || "11111";
      var postort = options.postort || "STOCKHOLM";
      var kontakt = options.kontakt || "Karl Kontakt";
      var email = options.email || "karl.kontakt@mail.com";
      var telefon = options.telefon || "0701234567";

      var blankettDatum = formatDate(new Date(), "");

      var info =
`#DATABESKRIVNING_START
#PRODUKT SRU
#SKAPAD ${blankettDatum}
#PROGRAM ownbox
#FILNAMN BLANKETTER.SRU
#DATABESKRIVNING_SLUT
#MEDIELEV_START
#ORGNR ${orgnr}
#NAMN ${bolagsnamn}
#POSTNR ${postnr}
#POSTORT ${postort}
#KONTAKT ${kontakt}
#EMAIL ${email}
#TELEFON ${telefon}
#MEDIELEV_SLUT`
;


      return info;
    }

    function generateBlankett() {

      var beskattningsperioder =
	  (["31/1, 28/2, 31/3, 30/4",
	    "31/5, 30/6",
	    "31/7, 31/8",
	    "30/9, 31/10, 30/11, 31/12"]).reduce( (a,v,i) => {
	      v.split(", ").forEach(d => {
		var [day, month] = d.split("/");
		a[("0"+month).slice(-2) + ("0"+day).slice(-2)] = "P" + (i+1);
	      });
	      return a;
	    },{});

      var deklarationsPeriod = startDate.getFullYear() + (beskattningsperioder[financialYearEndDate]);
      var bolagsnamn = options.bolagsnamn || "Demobolag AB";
      var identitet = options.identitet || "191010101010";
      var orgnr = options.orgnummer || "191010101010";
      var postnr = options.postnr || "11111";
      var postort = options.postort || "STOCKHOLM";
      var kontakt = options.kontakt || "Karl Kontakt";
      var email = options.email || "karl.kontakt@mail.com";
      var telefon = options.telefon || "0701234567";

      var datFramst = formatDate(new Date(), "");
      var tidFramst = formatTime(new Date(), "");

      var startDatum = formatDate(startDate, "");
      var slutDatum = formatDate(endPrintDate, "");



      var out = []

      out = out.concat(
`#BLANKETT INK2R-${deklarationsPeriod}
#IDENTITET ${identitet} ${datFramst} ${tidFramst}
#NAMN ${bolagsnamn}
#UPPGIFT 7011 ${startDatum}
#UPPGIFT 7012 ${slutDatum}`.split("\n"));

      out = out.concat(ink2r.map( (v) => ("#UPPGIFT " + v.srukod + " " + formatInteger(abs(v.saldo))) ) );
      out.push("#BLANKETTSLUT");

      out = out.concat(
	`#BLANKETT INK2S-${deklarationsPeriod}
#IDENTITET ${identitet} ${datFramst} ${tidFramst}
#NAMN ${bolagsnamn}
#UPPGIFT 7011 ${startDatum}
#UPPGIFT 7012 ${slutDatum}`.split("\n"));

      out = out.concat(ink2s.map( (v) => ("#UPPGIFT " + v.srukod + " " + formatInteger(abs(v.saldo))) ) );

      out.push("#BLANKETTSLUT");
      out.push("#FIL_SLUT");

      return out.join("\n") + "\n"
}

    console.log(generateBlankett());

    fs.writeFileSync("INFO.SRU", utf8toLATIN1Converter.convert(generateInfo()));
    fs.writeFileSync("BLANKETTER.SRU", utf8toLATIN1Converter.convert(generateBlankett()));

  },
  validate: function() {
    validateAccountingData(true);
  },

  seb: function(infile, outfile) {
    var ws = outfile ? fs.createWriteStream(outfile) : process.stdout;
    var t = SEBcsv2json((t) => {
      ws.write(JSON.stringify(t)+'\n');
    });
    lineReader(fs.createReadStream(infile, { encoding: 'latin1'}).on('end', () => {
      console.log("SEB done");
    })).on('line', (line) => t(line));


  },
  skv: function(infile, outfile) {
    var ws = outfile ? fs.createWriteStream(outfile) : process.stdout;
    var t = SKVcsv2json((t) => {
      ws.write(JSON.stringify(t)+'\n');
    });
    lineReader(fs.createReadStream(infile, { encoding: 'latin1'}).on('end', () => {
      console.log("SKV done");
    })).on('line', (line) => t(line));


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

    //filename = filename || options.accountingFile;

    if(filename) {
      console.log("transfer book to: " + filename);
      writeBook( { accountsList: nextYear }, filename);
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
  disableDebug();
} else {
  enableDebug();
}

setDates();

ledgerFile = ["accounting", options.orgnummer, finansialYearString, "json"].join('.');
transactionsFile = ["transactions", options.orgnummer, finansialYearString, "json"].join('.');

options.accountingFile = options.accountingFile || ledgerFile;
options.transactionsFile = options.transactionsFile || transactionsFile;

//console.log("verbose: " + verbose);

if(verbose) {
  console.log("run command: " + ('<' + args[0] + '>' || "<none>") + ", using options: " + JSON.stringify(options, null, 2));
}

if(options.noAuto || options.noAutobook) {
  options.autobook = false;
}

if(options.noAuto || options.noImportVerifications) {
  options.importVerifications = false;
}
Object.assign(cmds, exports);

function alldone() {
}

async function run() {
  await importBaskontoplan(options.baskontoplan);
  await importSRUkoder(options.srukoder);
  await readBook(options.infile || options.accountingFile);

  //dumpTransactions('2731');

  //console.log("readBook: " + JSON.stringify(accounts['1730']));
  await safeReadJsonFile(options.transactionsFile, transactions);

  //console.log("safeReadJsonFile: " + JSON.stringify(accounts['1730']));

  var firstAddedVernr = verificationNumber;

  options.importVerifications && await importVerifications();
  options.autobook && await autobookTransactions();

  remapTransactions();

  // at this point, all added verifications are unsorted, a.g A3 can be last and A100 first, which is confusing
  // so after all verifications has been sorted, renumber all above last commited verId

  sortVerifications();
  sortTransactions();

  renumberVerificationsFrom(firstAddedVernr);

  debug("accounting init done, run command");

  cmds[args[0]] ? await cmds[args[0]].apply(this, args.slice(1)) : (console.error("Unknown command: " + args[0] + ", valid commands: ", Object.keys(cmds)), alldone());

  var validationError = validateAccountingData();

  if(verbose) {
    console.log("Check if accounting ledger has changed and commit changes to: ", options.outfile || options.accountingFile);
    console.log("verificationNumber: %d,  lastVerificationNumber: %d", verificationNumber, lastVerificationNumber);
  }

  if(options.forceWrite || verificationNumber !== lastVerificationNumber) {
    console.log("accounting ledger has been updated");
    //debug("accounting has been updated: %d != %s", verificationNumber, lastVerificationNumber);
    if(options.commit) {
      var outfile = options.outfile || options.accountingFile;
      console.log("commit changes to %s", outfile);
      if(validationError) {
	console.log("accounting file not written, accounting data is erronous:\n", validationError);
      } else {
	await writeBook({ accountsList: accountsList, verifications: verifications }, outfile);
      }
    }
  } else {
    debug("accounting ledger has NOT changed: %d == %s", verificationNumber, lastVerificationNumber);
  }

  if(verbose) {
    console.log("Check if transactions ledger has changed and commit changes to: ", options.transactionsFile);
  }

  if(options.forceWrite || transactionsChanged) {
    console.log("transactions has been updated");
    if(options.commit) {
      console.log("commit changes to %s", options.transactionsFile);
      if(validationError) {
	console.log("transactions file not written, accounting data is erronous:\n", validationError);
      } else {
	await writeTransactions(options.transactionsFile);
      }
    }
  }

  if(options.dumpTransactions) {
      transactions.forEach(t => {
	console.log(json(t));
      });

  }

  var showMax = 10;
  transactions.filter(t => !t.registred).every(t => {
    if(showMax === 10) {
      console.log("Unbooked transactions:");
    }

    showMax--;
    if(!options.dumpUnbooked && (showMax < 0)) {
      return false;
    }

    console.log(json(t));

    return true;
  });
  if(showMax < 0) {
    console.log("...");
    console.log("not showing %d unbooked transactions", transactions.filter(t=> !t.registred).length);
  }


  if(options.dumpVerifications) {
    verifications.forEach(v => {
      console.log(json(v));
    });
  }

  if(options.validate) {
    var validationError = validateAccountingData();
    if(validationError) {
      console.log("validation of accounting data failed: ", validationError);
    }
  }
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
