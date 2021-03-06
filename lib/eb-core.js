/*!
 * EnigmaBridge core
 * @author Dusan Klinec (ph4r05)
 * @license MIT.
 */

/*jshint globalstrict: true*/
/*jshint node: true */
'use strict';

var sprintf = require('./eb-util-sprintf');
var ebextend = require('./eb-util-extend');
var inherit = require('./eb-util-inherit');
var RetryHandler = require('./eb-util-retry');
var sjcl = require('./built/sjcl/sjcl');
var BigInteger = require('jsbn').BigInteger;
var superagent = require('superagent');
var modurl = require('url');
var Promise = require("bluebird");
//var superagentNoCache = require('superagent-no-cache');

/**
 * Monkey-patching for prototype inheritance.
 *
 * @param parentClassOrObject
 * @param newPrototype
 * @returns {Function}
 */
Function.prototype.inheritsFrom = function( parentClassOrObject, newPrototype ){
    if ( parentClassOrObject.constructor === Function )
    {
        //Normal Inheritance
        this.prototype = new parentClassOrObject();
        this.prototype.constructor = this;
        this.prototype.parent = parentClassOrObject.prototype;

        // Better for calling super methods. Avoids looping.
        this.superclass = parentClassOrObject.prototype;
        this.prototype = ebextend(this.prototype, newPrototype);

        // If we have inheritance chain A->B->C, A = root, A defines method x()
        // B also defines x = function() { this.parent.x.call(this); }, C does not defines x,
        // then calling x on C will cause infinite loop because this references to C in B.x() and this.parent is B in B.x()
        // not A as desired.
    }
    else
    {
        //Pure Virtual Inheritance
        this.prototype = parentClassOrObject;
        this.prototype.constructor = this;
        this.prototype.parent = parentClassOrObject;
        this.superclass = parentClassOrObject;
    }
    return this;
};

/**
 * Base EB package.
 * @type {{name: string}}
 */
var eb = {
    name: "EB",
    exception: {},
    codec: {},
    padding: {},
    math: {},
    comm: {},
    client: {}
};

/** @namespace Exceptions. */
eb.exception = {
    /** @constructor Ciphertext is corrupt. */
    corrupt: function (message) {
        this.toString = function () {
            return "CORRUPT: " + this.message;
        };
        this.message = message;
    },
    /** @constructor Invalid input. */
    invalid: function (message) {
        this.toString = function () {
            return "INVALID: " + this.message;
        };
        this.message = message;
    }
};

/**
 * EB misc wrapper.
 * @type {{name: string, genNonce: eb.misc.genNonce, genHexNonce: eb.misc.genHexNonce, genAlphaNonce: eb.misc.genAlphaNonce, xor: eb.misc.xor}}
 */
eb.misc = {
    name: "misc",

    MAX_SAFE_INTEGER: Math.pow(2, 53) - 1,
    MIN_SAFE_INTEGER: -(Math.pow(2, 53) - 1),
    EPSILON: 2.2204460492503130808472633361816E-16,

    // Exporting used components to the EB namespace.
    sprintf: sprintf,
    extend: ebextend,
    inherit: inherit,
    RetryHandler: RetryHandler,
    sjcl: sjcl,
    BigInteger: BigInteger,
    superagent: superagent,
    url: modurl,
    Promise: Promise,

    /**
     * Generates random nonce of given length in characters from the given alphabet.
     *
     * @param {Number} length length of the nonce to generate
     * @param {String} alphabet alphabet of characters to use
     * @returns {String} nonce
     */
    genNonce: function(length, alphabet){
        var nonce = "";
        var alphabetLen = alphabet.length;
        var i = 0;

        for(i = 0; i < length; i++){
            nonce += alphabet.charAt(((sjcl.random.randomWords(1)[0]) & 0xffff) % alphabetLen);
        }

        return nonce;
    },

    /**
     * Generates nonce of the given length using hexadecimal alphabet [0-9a-f].
     *
     * @param {Number} length length of the nonce to generate in characters
     * @returns {String} nonce
     */
    genHexNonce: function(length){
        return this.genNonce(length, "0123456789abcdef");
    },

    /**
     * Generates nonce of the given length using alphanumerical alphabet [0-9a-z].
     *
     * @param {Number} length length of the nonce to generate in characters
     * @returns {String} nonce
     */
    genAlphaNonce: function (length){
        return this.genNonce(length, "0123456789abcdefghijklmnopqrstuvwxyz");
    },

    /**
     * Returns a new bitArray of length 128 bits, result of x XOR y.
     *
     * @param {bitArray|Array} x
     * @param {bitArray|Array} y
     * @returns {bitArray|Array} xor result.
     */
    xor: function(x, y){
        return [x[0]^y[0], x[1]^y[1], x[2]^y[2], x[3]^y[3]];
    },

    /**
     * Returns a new bitArray of length 256 bits, result of x XOR y.
     *
     * @param {bitArray|Array} x
     * @param {bitArray|Array} y
     * @returns {bitArray|Array} xor result.
     */
    xor8: function(x, y){
        return [x[0]^y[0], x[1]^y[1], x[2]^y[2], x[3]^y[3], x[4]^y[4], x[5]^y[5], x[6]^y[6], x[7]^y[7]];
    },

    absorb: function(dst, src){
        if (src === undefined){
            return dst;
        }

        for(var key in src) {
            if (src.hasOwnProperty(key)) {
                dst[key] = src[key];
            }
        }
        return dst;
    },

    absorbKey: function(dst, src, key){
        if (src !== undefined && key in src){
            dst[key] = src[key];
        }
        return dst;
    },

    absorbKeyEx: function(dst, dstKey, src, srcKey){
        if (src !== undefined && srcKey in src){
            dst[dstKey] = src[srcKey];
        }
        return dst;
    },

    absorbKeyIfNotSet: function(dst, dstKey, src, srcKey){
        if (src !== undefined
            && srcKey in src
            && src[srcKey] !== undefined
            && dst !== undefined
            && (!(dstKey in dst) || (dst[dstKey] === undefined)))
        {
            dst[dstKey] = src[srcKey];
        }
        return dst;
    },

    absorbValue: function(dst, value, valueKey, defaultValue){
        if (value !== undefined){
            dst[valueKey] = value;
        } else if (defaultValue !== undefined){
            dst[valueKey] = defaultValue;
        }
    },

    /**
     * Converts argument to the SJCL bitArray.
     * @param x
     *      if x is a number, it is converted to SJCL bitArray. Warning, 32bit numbers are supported only.
     *      if x is a string, it is considered as hex coded string.
     *      if x is an array it is considered as SJCL bitArray.
     * @returns {*}
     */
    inputToBits: function(x){
        if (typeof x === 'number'){
            return sjcl.codec.hex.toBits(sprintf("%02x", x));

        } else if (typeof x === 'string') {
            x = x.trim().replace(/^0x/, '');
            if (!(x.match(/^[0-9A-Fa-f]+$/))){
                throw new eb.exception.invalid("Invalid hex coded number");
            }

            return sjcl.codec.hex.toBits(x);

        } else {
            return x;

        }
    },

    /**
     * Converts argument to the hexcoded string.
     * @param x -
     *      if x is a number, will be converted to a hex string. Warning, 32bit numbers are supported only.
     *      if x is a string, it is considered as hex coded string.
     *      if x is an array it is considered as SJCL bitArray.
     */
    inputToHex: function(x){
        if (typeof x === 'number'){
            return sprintf("%x", x);

        } else if (typeof x === 'string') {
            x = x.trim().replace(/^0x/, '');
            if (!(x.match(/^[0-9A-Fa-f]+$/))){
                throw new eb.exception.invalid("Invalid hex coded number");
            }

            return x;

        } else {
            return sjcl.codec.hex.fromBits(x);

        }
    },

    /**
     * Converts argument to the integer. If string is passed, it is considered as hex-coded integer.
     * @param x
     * @param noThrow
     */
    inputToHexNum: function(x, noThrow){
        if (typeof x === 'number'){
            return x;

        } else if (typeof x === 'string') {
            x = x.trim().replace(/^0x/, '');
            if (!(x.match(/^[0-9A-Fa-f]+$/))){
                throw new eb.exception.invalid("Invalid hex coded number");
            }

            return parseInt(x, 16);

        } else if (noThrow === undefined || !noThrow) {
            throw new eb.exception.invalid("Invalid argument - not a number or string");

        } else {
            return x;

        }
    },

    /**
     * Function generates a zero bit vector of given size.
     * @param bitLength
     */
    getZeroBits: function(bitLength){
        if (bitLength <= 0) {
            return [];
        }

        var bs = [0, 0, 0, 0, 0, 0, 0, 0], i;
        for(i = 256; i < bitLength; i += 32){
            bs.push(0);
        }

        return sjcl.bitArray.bitSlice(bs, 0, bitLength);
    },

    /**
     * Function generates random bit vector of given length.
     * @param bitLength
     */
    getRandomBits: function(bitLength){
        return sjcl.bitArray.clamp(sjcl.random.randomWords(Math.ceil(bitLength/32)), bitLength);
    },

    /**
     * Converts given number to the bitArray representation.
     *
     * @param num
     * @param bitSize
     */
    numberToBits: function(num, bitSize){
        if (bitSize > 32){
            throw new eb.exception.invalid("num can be maximally 32bit wide");
        }
        if (bitSize == 32){
            return [num];
        }
        return sjcl.bitArray.bitSlice([num], 32 - bitSize, 32);
    },

    /**
     * Replaces part in the given buffer with the provided replacement
     *
     * @param {bitArray|Array} buffer
     * @param {Number} offsetStartBit
     * @param {Number} offsetEndBit
     * @param {bitArray|Array} replacement
     */
    replacePart: function(buffer, offsetStartBit, offsetEndBit, replacement){
        var w = sjcl.bitArray;
        var ba = w.concat(w.bitSlice(buffer, 0, offsetStartBit), replacement); // before + transform
        ba = w.concat(ba, w.bitSlice(buffer, offsetEndBit)); // after

        return ba;
    },

    /**
     * Function transforms given slice of the array by the function provided and replaces
     * original portion with the result of function call.
     *
     * @param {bitArray|Array} buffer
     * @param {Number} offsetStartBit
     * @param {Number} offsetEndBit
     * @param {Function} fction
     */
    transformPart: function(buffer, offsetStartBit, offsetEndBit, fction){
        var w = sjcl.bitArray;
        var slice = w.bitSlice(buffer, offsetStartBit, offsetEndBit);
        var ba = w.concat(w.bitSlice(buffer, 0, offsetStartBit), fction(slice)); // before + transform
        ba = w.concat(ba, w.bitSlice(buffer, offsetEndBit)); // after

        return ba;
    },

    /**
     * Serializes 64bit number to a bitArray.
     * @param {Number} num
     * @returns {bitArray|Array}
     */
    serialize64bit: function(num){
        return [Math.floor(num/0x100000000), (num|0)];
    },

    /**
     * Deserializes 64bit number from bitArray
     * @param {bitArray} arr
     * @param {number} [offset=0] Bit offset.
     */
    deserialize64bit: function(arr, offset){
        offset = offset || 0;
        var w = sjcl.bitArray;
        var hi = w.extract32(arr, offset);
        var lo = w.extract32(arr, offset+32);
        return (hi*0x100000000 + (lo) + (lo < 0 ? 0x100000000 : 0));
    },

    /**
     * Left zero padding to the even number of hexcoded digits.
     * @param x
     * @returns {*}
     */
    padHexToEven: function(x){
        x = x.trim().replace(/[\s]+/g, '').replace(/^0x/, '');
        return ((x.length & 1) == 1) ? ('0'+x) : x;
    },

    /**
     * Left zero padding for hex string to the given size.
     * @param x
     * @param size
     * @returns {*}
     */
    padHexToSize: function(x, size){
        x = x.trim().replace(/[\s]+/g, '').replace(/^0x/, '');
        return (x.length<size) ? (('0'.repeat(size-x.length))+x) : x;
    },

    /**
     * Pads number x to full block size.
     * Useful when computing total size after padding added.
     * If x is multiple of bs, another block is added (pkcs7 works in this way).
     *
     * @param x number of units
     * @param bs block size - same units as x
     */
    padToBlockSize: function(x, bs){
        return x + (bs - (x % bs));
    },

    /**
     * Returns the byte length of an utf8 string.
     * @param str
     * @returns {*}
     */
    strByteLength: function(str) {
        var s = str.length;
        for (var i=str.length - 1; i >= 0; i--) {
            var code = str.charCodeAt(i);
            if (code > 0x7f && code <= 0x7ff) {
                s++;
            }
            else if (code > 0x7ff && code <= 0xffff) {
                s+=2;
            }
            if (code >= 0xDC00 && code <= 0xDFFF) {
                i--; //trail surrogate
            }
        }
        return s;
    },

    /**
     * Returns true if src is defined and src.key is defined.
     * @param src
     * @param key
     * @returns {boolean}
     */
    isDefined: function(src, key){
        return src !== undefined && key in src && src[key] !== undefined;
    },

    /**
     * Generates checksum value from the input.
     * @param x hexcoded string or bitArray. If you want to checksum arbitrary string, hash it first.
     * @param size
     */
    genChecksumValue: function(x, size){
        var inputBits = eb.misc.inputToBits(x);

        // As we are reducing information from x to base32*size bits, we are performing
        // two hash rounds to make sure the dependency is non-trivial.
        var toHash = sjcl.codec.hex.fromBits(inputBits) + ',' + size + ',' + sjcl.bitArray.bitLength(inputBits);
        var inputHashBits = sjcl.hash.sha256.hash(toHash);
        var inputHashBits2 = sjcl.hash.sha256.hash(sjcl.codec.hex.fromBits(inputHashBits) + toHash);
        var hashOut = [], i;
        for(i=0; i<256/32; i++){
            hashOut[i] = inputHashBits[i] ^ inputHashBits2[i];
        }

        // Base 32, size first characters
        var base32string = sjcl.codec.base32.fromBits(hashOut);
        return base32string.substring(0, size);
    },

    /**
     * Generates checksum value from the input.
     * @param x an arbitraty string
     * @param size
     */
    genChecksumValueFromString: function(x, size){
        return eb.misc.genChecksumValue(sjcl.hash.sha256.hash(x), size);
    },

    /**
     * Asserts the condition.
     * @param condition
     * @param message
     */
    assert: function(condition, message) {
        if (!condition) {
            message = message || "Assertion failed";
            if (typeof Error !== "undefined") {
                throw new Error(message);
            }
            throw message; // Fallback
        }
    },

    /**
     * Parses url to the components.
     * https://nodejs.org/docs/latest/api/url.html
     * https://www.npmjs.com/package/url
     *
     * @param {String} url
     * @param {Boolean} [parseQuery=false]
     * @returns {{scheme: String, protocol: String, hostname: String, port: Integer}}
     */
    parseUrl: function(url, parseQuery) {
        parseQuery = parseQuery || false;
        var p = eb.misc.url.parse(url, parseQuery);
        if (typeof p.protocol !== 'undefined'){
            var proto = p.protocol;
            p.scheme = proto.slice(-1) === ':' ? proto.substring(0, proto.length - 1) : proto;
        }

        return p;
    },

    /**
     * Generates communication keys from the input.
     * Used to generate 2x 256bit comm keys from lower entropy key.
     * @param {bitArray|String} input
     * @returns {{enc, mac}}
     */
    regenerateCommKeys: function(input){
        var w = sjcl.bitArray;
        var baInput = eb.misc.inputToBits(input);
        var baEnc = sjcl.hash.sha256.hash(w.concat(baInput, [0x01]));
        var baMac = sjcl.hash.sha256.hash(w.concat(baInput, [0x02]));
        return {enc:baEnc, mac:baMac};
    },

    /**
     * If val is undefined, def is returned, val otherwise.
     * @param val
     * @param def
     * @returns {*}
     */
    def: function(val, def){
        return typeof val === 'undefined' ? def : val;
    }
};

/**
 * Fault tolerant utf8 codec for user entries.
 * When converting from hexcoded string to raw data, data may contain both UTF8 characters and hex-coded characters.
 * Parsing result finds utf8 characters in the hexbytes. If byte sequence does not form valid utf8 character, it is
 * parsed as ordinary hex sequence.
 *
 * When converting from raw data to hexdata, utf8 characters are allowed. Moreover it supports individual byte coding
 * \x[A-Fa-f0-9]{2} and backslash escaping \\. Single individual backslash is ignored.
 * @type {{}}
 */
eb.codec.utf8 = {
    toHex: function(x, options) {
        var i, ln = x.length;
        var out = "";

        for (i = 0; i < ln; i++) {
            var cChar = x.charAt(i);
            var remChars = (ln - i - 1);

            if (cChar === '\\') {
                // Byte coding \xFF ?
                if (remChars >= 3) {
                    var hCode = x.substring(i, i + 4);
                    var hRegex = /\\x([a-fA-F0-9]{2})/g;
                    var match = hRegex.exec(hCode);
                    if (match) {
                        out += match[1];
                        i += 3;
                        continue;
                    }
                }

                // Escaping \\ ?
                if (remChars >= 1) {
                    var nChar = x.substring(i + 1, i + 2);
                    if (nChar === '\\') {
                        out += Number('\\'.charCodeAt(0)).toString(16);
                        i += 1;
                        continue;
                    }
                }

                // Invalid escaping, ignore this backslash.
                continue;
            }

            // Get UTF8 hex representation.
            var cc = unescape(encodeURIComponent(cChar));
            var jj, llen;
            for (jj = 0, llen = cc.length; jj < llen; jj++) {
                var chNum = (Number(cc.charCodeAt(jj))).toString(16);
                if ((chNum.length & 1) == 1) {
                    chNum = "0" + chNum;
                }
                out += chNum;
            }
        }

        return out;
    },

    /**
     * Converts hexcoded string to raw data.
     * @param x
     * @param options
     * @returns {string}
     */
    fromHex: function(x, options) {
        var parsed = eb.codec.utf8.fromHexParse(x, options);
        var str="";
        var cur, i, len;
        for(i=0, len=parsed.parsed.length; i<len; i++){
            cur=parsed.parsed[i];
            str += cur.utf8 ? cur.rep : cur.enc;
        }

        return str;
    },

    /**
     * Parses hex coded string, can accept utf8 characters.
     * @param x
     * @param options,
     *      - if acceptUtf8==false, UTF8 characters are not recognized, each character has 1 byte encoding. Default = true,
     *        thus UTF8 characters are recognized and parsed.
     *      - if acceptOnlyUtf8==true, non-UTF8 characters are skipped, otherwise they are parsed as hexcoded.
     *
     * @returns {{nonUtf8Chars: number, parsed: Array}}
     */
    fromHexParse: function(x, options) {
        var defaults = {
            'acceptUtf8': true,
            'acceptOnlyUtf8': false
        };

        options = ebextend(defaults, options || {});
        var h = sjcl.codec.hex;
        var acceptUtf8 = options && options.acceptUtf8;
        var acceptOnlyUtf8 = options && options.acceptOnlyUtf8;

        // Process only even lengths.
        var ln = x.length;
        if ((ln & 1) == 1) {
            ln-=1;
        }

        var nonUtf8Chars = 0;
        var i, cByte, cBits, cNum;
        var out = [];

        // UTF8 encoding table
        //7 	U+0000	    U+007F	    1	0xxxxxxx
        //11	U+0080	    U+07FF	    2	110xxxxx	10xxxxxx
        //16	U+0800	    U+FFFF	    3	1110xxxx	10xxxxxx	10xxxxxx
        //21	U+10000	    U+1FFFFF	4	11110xxx	10xxxxxx	10xxxxxx	10xxxxxx
        //26	U+200000	U+3FFFFFF	5	111110xx	10xxxxxx	10xxxxxx	10xxxxxx	10xxxxxx
        //31	U+4000000	U+7FFFFFFF	6	1111110x	10xxxxxx	10xxxxxx	10xxxxxx	10xxxxxx	10xxxxxx
        for(i = 0; i < ln; i += 2){
            cByte = (x[i] + x[i+1]).toUpperCase();
            cBits = h.toBits(cByte);
            cNum = sjcl.bitArray.extract(cBits, 0, 8);

            // 1byte char representation. ASCII.
            if (!acceptUtf8 || (cNum & 0x80) === 0){
                var tmpChar = String.fromCharCode(cNum);
                if (tmpChar === "\\"){
                    tmpChar = "\\\\";
                }

                out.push({
                    'b':1,
                    'utf8':true,
                    'hex':cByte,
                    'enc':String.fromCharCode(cNum),
                    'rep':cNum < 32 || cNum >= 127 ? "\\x" + cByte : tmpChar});
                continue;
            }

            // Look for utf8 character.
            var remBytes = (ln-i-2)/2;
            var valid = false;
            var j = 0;
            for(j=2; j<=6; j++){
                // Create first UTF8 byte mask signature, j = number of bytes character occupies.
                var signature = (Math.pow(2, j)-1)<<1;
                var byteLow = cNum >> (8-j-1);
                if (signature !== byteLow){
                    continue;
                }

                // Signature matched, check if there is enough number of bytes in the buffer
                if (remBytes < (j-1)){
                    break;
                }

                // Start building \uxxxx representation.
                var utfOut = h.toBits(sprintf("0000%x", cNum & ((1<<(8-j-1))-1) ) );
                var utfOutLen = sjcl.bitArray.bitLength(utfOut);
                if (utfOutLen > (8-j-1)){
                    utfOut = sjcl.bitArray.bitSlice(utfOut, utfOutLen-(8-j-1));
                }

                // Check if each next byte has 10xxxxxx format.
                var k = 0;
                var byteValid = true;
                for(k=0; k<j-1; k++){
                    var nByte = eb.codec.utf8.getByte(x, i+2+2*k);
                    if ((nByte >>> 6) != 2){
                        byteValid = false;
                        break;
                    }

                    var cBitArray = h.toBits(sprintf("0000%x", nByte & ((1<<6)-1) ) );
                    var cBitLen = sjcl.bitArray.bitLength(cBitArray);
                    if (cBitLen >= 7){
                        cBitArray = sjcl.bitArray.bitSlice(cBitArray, cBitLen-6);
                    }

                    utfOut = sjcl.bitArray.concat(utfOut, cBitArray);
                }

                // Successing were not in the 10xxxxxx format.
                if(!byteValid){
                    break;
                }

                // utfOut needs to be left padded with zeros to be correctly interpreted.
                utfOutLen = sjcl.bitArray.bitLength(utfOut);
                if ((utfOutLen & 7) !== 0){
                    var toPadLen = 8-(utfOutLen & 7);
                    utfOut = sjcl.bitArray.concat(sjcl.bitArray.bitSlice([0, 0, 0, 0], 0, toPadLen), utfOut);
                }

                valid=true;
                out.push({
                    'b':j,
                    'utf8':true,
                    'hex':cByte + x.substring(i+2, i+2+(j-1)*2),
                    'enc':"\\u" + h.fromBits(utfOut),
                    'rep':String.fromCharCode(parseInt(h.fromBits(utfOut), 16))
                });

                i+=2*(j-1);
                break;
            }

            if (valid || acceptOnlyUtf8){
                continue;
            }

            out.push({
                'b':1,
                'utf8':false,
                'hex':cByte,
                'enc':"\\x" + cByte,
                'rep':"\\x" + cByte});

            nonUtf8Chars+=1;
        }

        return {'nonUtf8Chars':nonUtf8Chars, 'parsed':out};
    },

    getByte: function (str, offset){
        var cByte = str[offset] + str[offset+1];
        var cBits = sjcl.codec.hex.toBits(cByte);
        return sjcl.bitArray.extract(cBits, 0, 8);
    }
};

/**
 * EB padding schemes wrapper.
 * @type {{name: string}}
 */
eb.padding = {
    name: "padding"
};

/**
 * Padding - identity function.
 * @type {{name: string, pad: eb.padding.empty.pad, unpad: eb.padding.empty.unpad}}
 */
eb.padding.empty = {
    name: "empty",
    pad: function(a, blocklen){
        return a;
    },
    unpad: function(a, blocklen){
        return a;
    }
};

/**
 * PKCS7 padding.
 * @type {{name: string, pad: eb.padding.pkcs7.pad, unpad: eb.padding.pkcs7.unpad}}
 */
eb.padding.pkcs7 = {
    name: "pkcs7",
    pad: function(a, blocklen){
        blocklen = blocklen || 16;
        if (!blocklen || (blocklen & (blocklen - 1))){
            throw new sjcl.exception.corrupt("blocklength has to be power of 2");
        }
        if (blocklen != 16){
            throw new sjcl.exception.corrupt("blocklength different than 16 is not implemented yet");
            // TODO: implement multiple block sizes.
        }

        var bl = sjcl.bitArray.bitLength(a);
        var padLen = (16 - ((bl >> 3) & 15));
        var padFill = padLen * 0x1010101;
        return sjcl.bitArray.concat(a, [padFill, padFill, padFill, padFill]).slice(0, ((bl >> 3) + padLen) >> 2);
    },
    unpad: function(a, blocklen){
        blocklen = blocklen || 16;
        if (!blocklen || (blocklen & (blocklen - 1))){
            throw new sjcl.exception.corrupt("blocklength has to be power of 2");
        }
        if (blocklen != 16){
            throw new sjcl.exception.corrupt("blocklength different than 16 is not implemented yet");
            // TODO: implement multiple block sizes.
        }

        var w = sjcl.bitArray;
        var bl = w.bitLength(a);
        if (bl & 127 || !a.length) {
            throw new sjcl.exception.corrupt("input must be a positive multiple of the block size");
        }

        var bi = a[((bl>>3)>>2) - 1] & 255;
        if (bi === 0 || bi > 16) {
            throw new sjcl.exception.corrupt("pkcs#5 padding corrupt");
        }

        var bo = bi * 0x1010101;
        if (!w.equal(w.bitSlice([bo, bo, bo, bo], 0, bi << 3), w.bitSlice(a, (a.length << 5) - (bi << 3), a.length << 5))) {
            throw new sjcl.exception.corrupt("pkcs#5 padding corrupt");
        }

        return w.bitSlice(a, 0, (a.length << 5) - (bi << 3));
    }
};

/**
 *  PKCS 1.5 padding for RSA operation.
 *
 *  EB = 00 || BT || PS || 00 || D
 *      .. EB = encryption block
 *      .. 00 prefix so EB is not bigger than modulus.
 *      .. BT = 1B block type {00, 01} for private key operation, {02} for public key operation.
 *      .. PS = padding string. Has length k - 3 - len(D).
 *      if BT == 0, then padding consists of 0x0, but we need to know size of data in order to remove padding unambiguously.
 *      if BT == 1, then padding consists of 0xFF.
 *      if BT == 2, then padding consists of randomly generated bytes, does not contain 0x00 byte.
 *      .. D  = data
 *      [https://tools.ietf.org/html/rfc2313 PKCS#1 1.5]
 *
 * @type {{name: string, unpad: eb.padding.pkcs15.unpad, const: *, char: *}}
 */
eb.padding.pkcs15 = {
    name: "pkcs1.5",
    pad: function(a, blockLength, bt){
        var w = sjcl.bitArray;
        var bl = w.bitLength(a);
        var blb = bl / 8;
        if (bt === undefined){
            bt = 0;
        }
        if (bl & 7 || !a.length) {
            throw new sjcl.exception.corrupt("input type has to have be byte padded, bl="+bl);
        }

        if (bt !== 0 && bt !== 1 && bt !== 2){
            throw new sjcl.exception.corrupt("invalid BT size");
        }

        if (blb+3 > blockLength){
            throw new sjcl.exception.corrupt("data to pad is too big for the padding block length");
        }

        var psLen = blockLength - 3 - blb;
        var ps = [], i, tmp=0;
        for (i=0; i<psLen; i++) {
            var curByte = 0;
            if (bt == 1){
                curByte = 0xff;
            } else if (bt == 2){
                do {
                    curByte = (sjcl.random.randomWords(1)[0]) & 0xff;
                }while(curByte === 0);
            }

            tmp = tmp << 8 | curByte;
            if ((i&3) === 3) {
                ps.push(tmp);
                tmp = 0;
            }
        }
        if (i&3) {
            ps.push(sjcl.bitArray.partial(8*(i&3), tmp));
        }

        var baBuff = [sjcl.bitArray.partial(8, 0)];
        baBuff = w.concat(baBuff, [sjcl.bitArray.partial(8, bt)]);
        baBuff = w.concat(baBuff, ps);
        baBuff = w.concat(baBuff, [sjcl.bitArray.partial(8, 0)]);
        return w.concat(baBuff, a);
    },
    unpad: function(a){
        var w = sjcl.bitArray;
        var bl = w.bitLength(a);
        var blb = bl / 8;
        if (bl & 7 || blb < 3 || !a.length) {
            throw new sjcl.exception.corrupt("data size block is invalid");
        }

        // Check the first byte.
        var bOffset = 0;
        var prefixByte = w.extract(a, bOffset, 8);
        if (prefixByte !== 0x0){
            throw new sjcl.exception.corrupt("data size block is invalid");
        }

        bOffset += 8;
        var bt = w.extract(a, bOffset, 8);

        // BT can be only from set {0,1,2}.
        if (bt !== 0 && bt !== 1 && bt !== 2){
            throw new sjcl.exception.corrupt("Padding data error, BT is outside of the definition set");
        }

        // Find D in the padded data. Strategy depends on the BT.
        var dataPosStart = -1, i= 0, cur=0;
        if (bt === 0){
            // Scan for first non-null character.
            for(i = 2; i < blb; i++){
                cur = w.extract(a, 8*i, 8);
                if (cur !== 0){
                    dataPosStart = i;
                    break;
                }
            }

        } else if (bt == 1){
            // Find 0x0, report failure in 0xff
            var ffCorrect = true;
            for(i = 2; i < blb; i++){
                cur = w.extract(a, 8*i, 8);
                if (cur !== 0 && cur !== 0xff) {
                    ffCorrect = false;
                }

                if (cur === 0){
                    dataPosStart = i+1;
                    break;
                }
            }

            if (!ffCorrect){
                throw new sjcl.exception.corrupt("Trail of 0xFF in padding contains also unexpected characters");
            }

        } else {
            // bt == 2, find 0x0.
            for(i = 2; i < blb; i++){
                cur = w.extract(a, 8*i, 8);
                if (cur === 0){
                    dataPosStart = i+1;
                    break;
                }
            }
        }

        // If data position is out of scope, return nothing.
        if (dataPosStart < 0 || dataPosStart > blb){
            throw new sjcl.exception.corrupt("Padding could not be parsed, dataStart=" + dataPosStart + ", len="+blb);
        }

        // Check size of the output buffer. note: dataLen = blb - dataPosStart;
        return w.bitSlice(a, dataPosStart*8);
    }
};

/**
 * Extracts 32bit number from the bitArray.
 * Original extract does not work with blength = 32 as 1<<32 == 1, it returns 0 always.
 *
 * @param a
 * @param bstart
 * @returns {*}
 */
sjcl.bitArray.extract32 = function(a, bstart){
    var x, sh = Math.floor((-bstart-32) & 31);
    if ((bstart + 32 - 1 ^ bstart) & -32) {
        x = (a[bstart/32|0] << (32 - sh)) ^ (a[bstart/32+1|0] >>> sh);
    } else {
        x = a[bstart/32|0] >>> sh;
    }
    return x;
};

/**
 * CBC-MAC with given cipher & padding.
 * @param Cipher
 * @param bs
 * @param padding
 */
sjcl.misc.hmac_cbc = function (Cipher, bs, padding) {
    this._cipher = Cipher;
    this._bs = bs = bs || 16;
    this._padding = padding = padding || eb.padding.empty;
};

/**
 * HMAC with the specified hash function.  Also called encrypt since it's a prf.
 * @param {bitArray|String} data The data to mac.
 */
sjcl.misc.hmac_cbc.prototype.encrypt = sjcl.misc.hmac_cbc.prototype.mac = function (data) {
    var i, w = sjcl.bitArray, bl = w.bitLength(data), bp = 0, xor = eb.misc.xor;
    var bsb = this._bs << 3;

    data = this._padding.pad(data, this._bs);
    var c = eb.misc.getZeroBits(this._bs*8);
    for (i = 0; bp + bsb <= bl; i += 4, bp += bsb) {
        c = this._cipher.encrypt(xor(c, data.slice(i, i + 4)));
    }
    return c;
};

/**
 * CBC encryption mode implementation.
 * @type {{name: string, encrypt: sjcl.mode.cbc.encrypt, decrypt: sjcl.mode.cbc.decrypt}}
 */
sjcl.mode.cbc = {
    name: "cbc",
    encrypt: function (a, b, c, d, noPad) {
        if (d && d.length) {
            throw new sjcl.exception.invalid("cbc can't authenticate data");
        }
        if (sjcl.bitArray.bitLength(c) !== 128) {
            throw new sjcl.exception.invalid("cbc iv must be 128 bits");
        }

        var i, w = sjcl.bitArray, bl = w.bitLength(b), bp = 0, output = [], xor = eb.misc.xor;
        if (noPad && (bl & 127) !== 0){
            throw new sjcl.exception.invalid("when padding is disabled, plaintext has to be a positive multiple of a block size");
        }
        if ((bl & 7) !== 0) {
            throw new sjcl.exception.invalid("pkcs#5 padding only works for multiples of a byte");
        }

        for (i = 0; bp + 128 <= bl; i += 4, bp += 128) {
            c = a.encrypt(xor(c, b.slice(i, i + 4)));
            output.splice(i, 0, c[0], c[1], c[2], c[3]);
        }

        if (!noPad){
            bl = (16 - ((bl >> 3) & 15)) * 0x1010101;
            c = a.encrypt(xor(c, w.concat(b, [bl, bl, bl, bl]).slice(i, i + 4)));
            output.splice(i, 0, c[0], c[1], c[2], c[3]);
        }

        return output;
    },
    decrypt: function (a, b, c, d, noPad) {
        if (d && d.length) {
            throw new sjcl.exception.invalid("cbc can't authenticate data");
        }
        if (sjcl.bitArray.bitLength(c) !== 128) {
            throw new sjcl.exception.invalid("cbc iv must be 128 bits");
        }
        if ((sjcl.bitArray.bitLength(b) & 127) || !b.length) {
            throw new sjcl.exception.corrupt("cbc ciphertext must be a positive multiple of the block size");
        }
        var i, w = sjcl.bitArray, bi, bo, output = [], xor = eb.misc.xor;
        d = d || [];
        for (i = 0; i < b.length; i += 4) {
            bi = b.slice(i, i + 4);
            bo = xor(c, a.decrypt(bi));
            output.splice(i, 0, bo[0], bo[1], bo[2], bo[3]);
            c = bi;
        }
        if (!noPad) {
            bi = output[i - 1] & 255;
            if (bi === 0 || bi > 16) {
                throw new sjcl.exception.corrupt("pkcs#5 padding corrupt"); //TODO: padding oracle?
            }
            bo = bi * 0x1010101;
            if (!w.equal(w.bitSlice([bo, bo, bo, bo], 0, bi << 3), w.bitSlice(output, (output.length << 5) - (bi << 3), output.length << 5))) {
                throw new sjcl.exception.corrupt("pkcs#5 padding corrupt"); //TODO: padding oracle?
            }
            return w.bitSlice(output, 0, (output.length << 5) - (bi << 3));
        } else {
            return output;
        }
    }
};

/**
 * Request builder.
 * @type {{}}
 */
eb.comm = {
    name: "comm",

    REQ_METHOD_GET: "GET",
    REQ_METHOD_POST: "POST",

    /**
     * General status constants.
     */
    status: {
        ERROR_CLASS_SECURITY:           0x2000,

        ERROR_CLASS_WRONGDATA:          0x8000,
        SW_INVALID_TLV_FORMAT:          0x8000 | 0x04c,
        SW_WRONG_PADDING:               0x8000 | 0x03d,
        SW_STAT_INVALID_APIKEY:         0x8000 | 0x068,
        SW_AUTHMETHOD_NOT_ALLOWED:      0x8000 | 0x0b9,

        ERROR_CLASS_SECURITY_USER:      0xa000,
        SW_HOTP_KEY_WRONG_LENGTH:       0xa000 | 0x056,
        SW_HOTP_TOO_MANY_FAILED_TRIES:  0xa000 | 0x066,
        SW_HOTP_WRONG_CODE:             0xa000 | 0x0b0,
        SW_HOTP_COUNTER_OVERFLOW:       0xa000 | 0x0b3,
        SW_AUTHMETHOD_UNKNOWN:          0xa000 | 0x0ba,
        SW_AUTH_TOO_MANY_FAILED_TRIES:  0xa000 | 0x0b1,
        SW_AUTH_MISMATCH_USER_ID:       0xa000 | 0x0b6,
        SW_PASSWD_TOO_MANY_FAILED_TRIES:0xa000 | 0x063,
        SW_PASSWD_INVALID_LENGTH:       0xa000 | 0x064,
        SW_WRONG_PASSWD:                0xa000 | 0x065,

        SW_STAT_OK:                     0x9000,
        ERROR_CLASS_ERR_CHECK_ERRORS_6f:0x6f00,

        PDATA_FAIL_CONNECTION:          0x1,
        PDATA_FAIL_RESPONSE_PARSING:    0x3,
        PDATA_FAIL_RESPONSE_FAILED:     0x2,
    },

    /**
     * Converts mangled nonce value to the original one in ProcessData response.
     * ProcessData response has nonce return value response_nonce[i] = request_nonce[i] + 0x1
     * @param nonce
     * @returns {*}
     */
    demangleNonce: function(nonce){
        var w = sjcl.bitArray;
        var bl = w.bitLength(nonce);
        if ((bl&7) !== 0){
            throw new sjcl.exception.invalid("nonce has to be aligned to bytes");
        }

        var i, bp = 0, output = [], c;
        for (i = 0; bp + 32 <= bl; i += 1, bp += 32) {
            c = nonce.slice(i, i + 1)[0] - 0x01010101;
            output.splice(i, 0, c);
        }

        if (bp+32 == bl){
            return output;
        }

        var rbl = bl - (bp-32);
        var sub = 0x01010101 & (((1<<rbl)-1)<<(32-rbl));
        c = (nonce.slice(i, i + 1)[0] - sub) >>> rbl;
        output.splice(i, 0, c);
        return w.clamp(output, bl);
    },

    /**
     * Constructs UO handle.
     *
     * @param {String} apiKey
     * @param {Number|String} [uoId]
     * @param {Number|String} [uoType]
     * @returns {String} handle
     */
    getUoHandle: function(apiKey, uoId, uoType){
        // TEST_API 00 00000013 00 00a00004
        if (uoId === undefined){
            return apiKey;
        }

        if (uoType === undefined){
            uoType = 0;
        }

        return sprintf("%s00%08x00%08x", apiKey, eb.misc.inputToHexNum(uoId), eb.misc.inputToHexNum(uoType));
    },

    /**
     * Parses handle string to its components.
     * @param {String} handle
     * @returns {{apiKey:String, uoId:String, uoType:String}} parsed handle
     */
    parseHandle: function(handle) {
        var handleRe = /^([a-zA-Z0-9_-]+?)00([0-9a-fA-F]{8})(?:00([0-9a-fA-F]{8}))?$/;
        var res = handle.match(handleRe);
        if (res === null){
            throw new eb.exception.invalid("Invalid handle: " + handle);
        }
        return {
            apiKey: res[1],
            uoId: res[2],
            uoType: res[3]
        };
    },

    /**
     * Base class constructor.
     */
    base: function(){

    },

    /**
     * User object constructor
     */
    uo: function(uoid, encKey, macKey){
        var av = eb.misc.absorbValue;
        av(this, uoid, 'uoid');
        av(this, encKey, 'encKey');
        av(this, macKey, 'macKey');
    }
};
eb.comm.base.prototype = {
    /**
     * If set to true, request body building steps are logged.
     * @input
     */
    debuggingLog: false,

    /**
     * Aux logging function
     * @input
     */
    logger: null,

    _log:  function(x) {
        if (!this.debuggingLog){
            return;
        }

        if (console && console.log){
            console.log(x);
        }

        if (this.logger){
            this.logger(x);
        }
    }
};
eb.comm.uo.prototype = {
    /**
     * User object ID.
     */
    uoid: undefined,

    /**
     * Encryption communication key.
     */
    encKey: undefined,

    /**
     * MAC communication key.
     */
    macKey: undefined,
};

/**
 * Raw EB request builder.
 *
 * Data format before encryption:
 * buff = 0x1f | <UOID-4B> | <freshness-nonce-8B> | userdata
 *
 * Encryption
 * AES-256/CBC/PKCS7, IV = 0x00000000000000000000000000000000
 *
 * MAC
 * AES-256-CBC-MAC.
 *
 * encBlock = enc(buff)
 * result = encBlock || mac(encBlock)
 *
 * output = Packet0| _PLAINAES_ | <plain-data-length-4B> | <plaindata> | hexcode(result)
 *
 * @param nonce
 * @param aesKey
 * @param macKey
 * @param userObjectId
 * @param reqType
 */
eb.comm.processDataRequestBodyBuilder = function(nonce, aesKey, macKey, userObjectId, reqType){
    this.userObjectId = eb.misc.def(userObjectId, -1);
    this.nonce = nonce || "";
    this.aesKey = aesKey || "";
    this.macKey = macKey || "";
    this.reqType = reqType || "PLAINAES";
};
eb.comm.processDataRequestBodyBuilder.prototype = {
    /**
     * User object ID, integer type.
     * @input
     */
    userObjectId : -1,

    /**
     * AES communication encryption key, hexcoded string.
     * @input
     */
    aesKey: "",

    /**
     * AES MAC communication key, hexcoded string.
     * @input
     */
    macKey: "",

    /**
     * Freshness nonce / IV, hexcoded string.
     * @input
     */
    nonce: "",

    /**
     * Request type. PLAINAES by default.
     * @input
     */
    reqType: "",

    /**
     * If set to true, request body building steps are logged.
     * @input
     */
    debuggingLog: false,

    /**
     * Aux logging function
     * @input
     */
    logger: null,

    genNonce: function(){
        this.nonce = eb.misc.genHexNonce(16);
        return this.nonce;
    },

    /**
     * Builds EB request.
     *
     * @param plainData - bitArray of the plaintext data.
     * @param requestData - bitArray with userdata to perform operation on (will be encrypted, MAC protected)
     * @returns request body string.
     */
    build: function(plainData, requestData){
        this.nonce = this.nonce || eb.misc.genHexNonce(16);
        var h = sjcl.codec.hex;
        var ba = sjcl.bitArray;
        var pad = eb.padding.pkcs7;

        // Plain data is empty for now.
        var baPlain = plainData;
        var plainDataLength = ba.bitLength(baPlain)/8;

        // Input data flag
        var baBuff = [ba.partial(8, 0x1f)];
        // User Object ID
        baBuff = ba.concat(baBuff, [eb.misc.inputToHexNum(this.userObjectId)]);
        // Freshness nonce
        baBuff = ba.concat(baBuff, eb.misc.inputToBits(this.nonce));
        // User data
        baBuff = ba.concat(baBuff, requestData);
        // Add padding.
        baBuff = pad.pad(baBuff);
        this._log('ProcessData function input PDIN (0x1f | <UOID-4B> | <nonce-8B> | data | pkcs#7padding) : ' + h.fromBits(baBuff) + "; len: " + ba.bitLength(baBuff));

        var aesKeyBits = eb.misc.inputToBits(this.aesKey);
        var macKeyBits = eb.misc.inputToBits(this.macKey);

        var aes = new sjcl.cipher.aes(aesKeyBits);
        var aesMac = new sjcl.cipher.aes(macKeyBits);
        var hmac = new sjcl.misc.hmac_cbc(aesMac, 16, eb.padding.empty);

        // IV is null, nonce in the first block is kind of IV.
        var IV = [0, 0, 0, 0];
        var encryptedData = sjcl.mode.cbc.encrypt(aes, baBuff, IV, [], true);
        this._log('Encrypted ProcessData input ENC(PDIN): ' + h.fromBits(encryptedData) + ", len=" + ba.bitLength(encryptedData));

        // include plain data in the MAC if non-empty.
        var hmacData = hmac.mac(encryptedData);
        this._log('MAC(ENC(PDIN)): ' + h.fromBits(hmacData));

        // Build the request block.
        var requestBase = sprintf('Packet0_%s_%04X%s%s%s',
            this.reqType,
            plainDataLength,
            h.fromBits(plainData),
            h.fromBits(encryptedData),
            h.fromBits(hmacData)
        );

        this._log('ProcessData request body: ' + requestBase);
        return requestBase;
    },

    _log:  function(x) {
        if (!this.debuggingLog){
            return;
        }

        if (console && console.log){
            console.log(x);
        }

        if (this.logger){
            this.logger(x);
        }
    }
};

/**
 * Base class for parsed raw EB response.
 */
eb.comm.response = function(){

};
eb.comm.response.prototype = {
    /**
     * Parsed status code. 0x9000 = OK.
     * @output
     */
    statusCode: 0,

    /**
     * Parsed status detail.
     * @output
     */
    statusDetail: "",

    /**
     * Function name extracted from the request.
     */
    function: "",

    /**
     * Raw result of the call.
     * Usually processed by child classes.
     */
    result: "",

    /**
     * Returns true if after parsing, code is OK.
     * @returns {boolean}
     */
    isCodeOk: function(){
        return this.statusCode == eb.comm.status.SW_STAT_OK;
    },

    toString: function(){
        return sprintf("Response{statusCode=0x%4X, statusDetail=[%s], userObjectId: 0x%08X, function: [%s], result: [%s]}",
            this.statusCode,
            this.statusDetail,
            eb.misc.inputToHexNum(this.userObjectID, true),
            this.function,
            JSON.stringify(this.result)
        );
    }
};

/**
 * Process data response.
 * Parsed from processData EB response.
 * @extends eb.comm.response
 */
eb.comm.processDataResponse = function(){

};
eb.comm.processDataResponse.inheritsFrom(eb.comm.response, {
    /**
     * Plain data parsed from the response.
     * Nor MACed neither encrypted.
     * @output
     */
    plainData: "",

    /**
     * Protected data parsed from the response.
     * Protected by MAC, encrypted in transit.
     * @output
     */
    protectedData: "",

    /**
     * USerObjectID parsed from the response.
     * Ingeter, 4B.
     */
    userObjectID: 0,

    /**
     * Nonce parsed from the RAW response.
     */
    nonce: "",

    /**
     * MAC value parsed from the message.
     * If macOk is true, it is same as computed MAC.
     */
    mac: "",

    /**
     * Computed MAC value for the message.
     */
    computedMac: "",

    /**
     * Returns true if MAC verification is OK.
     */
    isMacOk: function(){
        var ba = sjcl.bitArray;
        return this.mac         &&
            this.computedMac    &&
            ba.bitLength(this.mac) == 16 * 8         &&
            ba.bitLength(this.computedMac) == 16 * 8 &&
            ba.equal(this.mac, this.computedMac);
    },

    toString: function(){
        return sprintf("ProcessDataResponse{statusCode=0x%4X, statusDetail=[%s], userObjectId: 0x%08X, function: [%s], " +
            "nonce: [%s], protectedData: [%s], plainData: [%s], mac: [%s], computedMac: [%s], macOK: %d",
            this.statusCode,
            this.statusDetail,
            eb.misc.inputToHexNum(this.userObjectID, true),
            this.function,
            sjcl.codec.hex.fromBits(this.nonce),
            sjcl.codec.hex.fromBits(this.protectedData),
            sjcl.codec.hex.fromBits(this.plainData),
            sjcl.codec.hex.fromBits(this.mac),
            sjcl.codec.hex.fromBits(this.computedMac),
            this.isMacOk()
        );
    }
});

/**
 * EB Import public key.
 */
eb.comm.pubKey = function(){};
eb.comm.pubKey.prototype = {
    id: undefined,
    type: undefined,
    certificate: undefined,
    key: undefined,

    toString: function(){
        return sprintf("pubKey{id=0x%04X, type=[%s], certificate:[%s], key:[%s]",
            this.id,
            this.type,
            this.certificate ? sjcl.codec.hex.fromBits(this.certificate) : "null",
            this.key ? sjcl.codec.hex.fromBits(this.key) : "null"
        );
    }
};

/**
 * pubKey response.
 * @extends eb.comm.response
 */
eb.comm.pubKeyResponse = function(x){
    eb.misc.absorb(this, x);
};
eb.comm.pubKeyResponse.inheritsFrom(eb.comm.response, {
    /**
     * Plain data parsed from the response.
     * Nor MACed neither encrypted.
     * @output
     */
    keys: [],

    toString: function(){
        var stringKeys = [], index, len, c;
        for (index = 0, len =this.keys.length; index < len; ++index) {
            c = this.keys[index];
            if (c){
                stringKeys.push(c.toString());
            }
        }

        return sprintf("pubKeyResponse{statusCode=0x%4X, statusDetail=[%s], function: [%s], keys:[%s]",
            this.statusCode,
            this.statusDetail,
            this.function,
            stringKeys.join(", ")
        );
    }
});

/**
 * Raw EB Response parser.
 */
eb.comm.responseParser = function(){

};
eb.comm.responseParser.prototype = {
    /**
     * Parsed response
     * @output
     */
    response: null,

    /**
     * If set to true, response body parsing steps are logged to the console.
     * @input
     */
    debuggingLog: false,

    /**
     * Aux logging function
     * @input
     */
    logger: null,

    /**
     * User can define response parsing function here, called in the main parse body.
     * It is optional function callback, must return response.
     * @input
     */
    _responseParsingFunction: undefined,
    parsingFunction: function(x){
        this._responseParsingFunction = x;
        return this;
    },

    /**
     * Returns true if after parsing, code is OK.
     * @returns {boolean}
     */
    success: function(){
        return this.response.isCodeOk();
    },

    /**
     * Parses common JSON headers from the response, e.g., status, to the provided message.
     * @param resp
     * @param data
     * @returns {eb.comm.response}
     */
    parseCommonHeaders: function(resp, data){
        if (!data || !data.status || !data.function){
            throw new sjcl.exception.invalid("response data invalid");
        }

        // Build new response message.
        resp.statusCode = parseInt(data.status, 16);
        resp.statusDetail = data.statusdetail || "";
        resp.function = data.function;
        resp.result = data.result;
        return resp;
    },

    /**
     * Parse EB response
     *
     * @param data - json response
     * @param resp - response object to put data to.
     * @param options
     * @returns request unwrapped response.
     */
    parse: function(data, resp, options){
        resp = resp || this.response;
        resp = resp || new eb.comm.response();
        this.response = resp;
        this.parseCommonHeaders(resp, data);

        // Build new response message.
        if (!this.success()){
            this._log("Error in processing, status: " + data.status + ", message: " + resp.statusDetail);
        }

        // If parsing function is already set, use it.
        if (this._responseParsingFunction){
            this.response = this._responseParsingFunction(data, resp, this);
            return this.response;
        }

        return resp;
    },

    _log:  function(x) {
        if (!this.debuggingLog){
            return;
        }

        if (console && console.log){
            console.log(x);
        }

        if (this.logger){
            this.logger(x);
        }
    }
};

/**
 * Parser parsing namely ProcessData response.
 * Data returned is encoded in the particular form, encrypted and MACed.
 * This response parser unwraps protected response.
 *
 * @param aesKey
 * @param macKey
 * @extends eb.comm.responseParser
 */
eb.comm.processDataResponseParser = function(aesKey, macKey){
    this.aesKey = aesKey || "";
    this.macKey = macKey || "";
};
eb.comm.processDataResponseParser.inheritsFrom(eb.comm.responseParser, {
    /**
     * Parsed user object ID, integer type.
     * @input
     */
    userObjectId : -1,

    /**
     * AES communication encryption key, hexcoded string.
     * @input
     */
    aesKey: "",

    /**
     * AES MAC communication key, hexcoded string.
     * @input
     */
    macKey: "",

    /**
     * Parse EB response
     *
     * @param data - json response
     * @param resp - response object to put data to.
     * @param options
     * @returns request unwrapped response.
     */
    parse: function(data, resp, options){
        resp = resp || this.response;
        resp = resp || new eb.comm.processDataResponse();
        this.response = resp;

        this.parseCommonHeaders(resp, data);
        if (!this.success()){
            this._log("Error in processing, status: " + data.status + ", message: " + resp.statusDetail);
            return resp;
        }

        // Shortcuts.
        var h = sjcl.codec.hex;
        var ba = sjcl.bitArray;

        // Build new response message.
        var resultBuffer = resp.result;
        var baResult = h.toBits(resultBuffer.substring(0, resultBuffer.indexOf("_")));
        var plainLen = ba.extract(baResult, 0, 2*8);
        var plainBits = ba.bitSlice(baResult, 2*8, 2*8+plainLen*8);
        var protectedBits = ba.bitSlice(baResult, 2*8+plainLen*8);
        var protectedBitsBl = ba.bitLength(protectedBits);

        // Decrypt and verify
        var aesKeyBits = eb.misc.inputToBits(this.aesKey);
        var macKeyBits = eb.misc.inputToBits(this.macKey);
        var aes = new sjcl.cipher.aes(aesKeyBits);
        var aesMac = new sjcl.cipher.aes(macKeyBits);
        var hmac = new sjcl.misc.hmac_cbc(aesMac, 16, eb.padding.empty);

        // Verify MAC.
        var macTagOffset = protectedBitsBl - 16*8;
        var dataToMac = ba.bitSlice(protectedBits, 0, macTagOffset);
        if ((ba.bitLength(dataToMac) & 127) !== 0){
            throw new sjcl.exception.corrupt("Padding size invalid");
        }

        resp.mac = ba.bitSlice(protectedBits, macTagOffset);
        if (ba.bitLength(resp.mac) !== 16*8){
            throw new sjcl.exception.corrupt("MAC corrupted");
        }

        resp.computedMac = hmac.mac(dataToMac);
        if (!resp.mac || !ba.equal(resp.mac, resp.computedMac)){
            throw new sjcl.exception.corrupt("Padding is not valid"); //TODO: padding oracle?
        }

        // Decrypt.
        var dataToDecrypt = ba.bitSlice(protectedBits, 0, macTagOffset);
        if ((ba.bitLength(dataToDecrypt) & 127) !== 0){
            throw new sjcl.exception.corrupt("Ciphertext block invalid");
        }

        // IV is null, nonce in the first block is kind of IV.
        var IV = [0, 0, 0, 0];
        var decryptedData = sjcl.mode.cbc.decrypt(aes, dataToDecrypt, IV, [], false);
        this._log("decryptedData: " + h.fromBits(decryptedData) + ", len=" + ba.bitLength(decryptedData));

        // Check the flag.
        var responseFlag = ba.extract(decryptedData, 0, 8);
        if (responseFlag !== 0xf1){
            throw new sjcl.exception.corrupt("Given data packet is not a response (flag mismatch)");
        }

        // Get user object.
        resp.userObjectID = ba.extract32(decryptedData, 8);

        // Get nonce, mangled.
        var returnedMangledNonce = ba.bitSlice(decryptedData, 5*8, 5*8+8*8);
        resp.nonce = eb.comm.demangleNonce(returnedMangledNonce);

        // Response = plainData + decryptedData.
        resp.protectedData = ba.bitSlice(decryptedData, 5*8+8*8);
        resp.plainData = plainBits;
        this._log("responseData: " + h.fromBits(resp.protectedData));

        return resp;
    }
});

/**
 * Simple connector to the EB interface.
 * The lowest interface responsible for communicating with EB endpoints.
 * Configurable for https/http GET/POST.
 *
 * Internally uses either JQuery ajax request or SuperAgent, if JQuery is not found.
 */
eb.comm.connector = function(){

};
eb.comm.connector.prototype = {
    objName: "connector",
    /**
     * Method to do REST request with. GET or POST are allowed.
     * @input
     */
    requestMethod: eb.comm.REQ_METHOD_POST,

    /**
     * Scheme used to contact remote API.
     * @input
     * @default https
     */
    requestScheme: "https",

    /**
     * Request timeout in milliseconds.
     * @input
     * @default 30000
     */
    requestTimeout: 30000,

    /**
     * Endpoint where EB API listens
     * @input
     */
    remoteEndpoint: "site1.enigmabridge.com",

    /**
     * Port of the remote endpoint
     * @input
     * @default 11180
     */
    remotePort: 11180,

    /**
     * Ajax call settings. User can modify default behavior by specifying settings here.
     * @input
     */
    ajaxSettings: {},

    /**
     * If set to true, request body building steps are logged.
     * @input
     */
    debuggingLog: false,

    /**
     * Aux logging function
     * @input
     */
    logger: null,

    /**
     * Request start time. Measure how long it took.
     * @output
     */
    requestTime: 0,

    /**
     * Raw request generated by the build call.
     * e.g., transmitted in the GET query method parameters / URL.
     */
    reqHeader: undefined,

    /**
     * Body part of the request.
     * e.g., transmitted in body of the HTTP message.
     */
    reqBody: undefined,

    /**
     * Response generated by response array.
     * @output
     */
    response: undefined,

    /**
     * RAW response from the server.
     * @output
     */
    rawResponse: undefined,

    /**
     * Response parser used to parse the response.
     * If not defined before calling doRequest method, default response parser is created.
     */
    responseParser: undefined,

    /**
     * Socket equivalent request, for debugging.
     * Generated when building the request.
     * @private
     */
    _socketRequest: "",

    _doneCallback: function(response, requestObj, data){},
    _failCallback: function(failType, data){},
    _alwaysCallback: function(requestObj, data){},

    done: function(x){
        this._doneCallback = x;
        return this;
    },

    fail: function(x){
        this._failCallback = x;
        return this;
    },

    always: function(x){
        this._alwaysCallback = x;
        return this;
    },

    /**
     * Returns if the EB returned with success.
     * Note: Data still may have invalid MAC.
     * @returns {*|boolean}
     */
    wasSuccessful: function(){
        return this.responseParser.success();
    },

    /**
     * Process configuration from the config object.
     * @param {Object} [configObject] json object with the configuration.
     * @param {String} [configObject.host] endpoint to use, e.g. https://site2.enigmabridge.com:11180.
     *                 Parsed to remoteEndpoint, remotePort, requestScheme
     * @param {String} [configObject.endpoint] alias for configObject.host
     * @param {String} [configObject.remoteEndpoint] hostname of the enpoint to call.
     * @param {String} [configObject.remotePort] port of the remote endpoint to connect to.
     * @param {String} [configObject.requestMethod] request method to use (e.g., GET, POST).
     * @param {String} [configObject.requestScheme] scheme / protocol to use for remote endpoint (e.g., http, https)
     * @param {Integer} [configObject.requestTimeout] request timeout in milliseconds
     * @param {Boolean} [configObject.debuggingLog] if true debugging logs will be logged
     * @param {Function} [configObject.logger] logger function to log messages into
     * @param {Object} [configObject.responseParser] Override Response parser object
     * @param {Object} [configObject.reqHeader] Override Request header
     * @param {Object} [configObject.reqBody] Override Request body
     */
    configure: function(configObject){
        if (!configObject){
            this._log("Invalid config object");
            return;
        }

        // Parse host as URL
        var toConfig = configObject;

        // Host / endpoint parsing.
        var tmpHost = undefined;
        if (eb.misc.isDefined(configObject, "host")){
            tmpHost = configObject.host;
        }
        if (eb.misc.isDefined(configObject, "endpoint")){
            tmpHost = configObject.endpoint;
        }

        if (tmpHost !== undefined){
            var p = eb.misc.parseUrl(tmpHost);
            var hostConf = {"remoteEndpoint": p.hostname};
            if (p.port !== undefined && p.port > 0){
                hostConf.remotePort = p.port;
            }
            if (p.scheme !== undefined && typeof p.scheme === 'string'){
                hostConf.requestScheme = p.scheme;
            }
            toConfig = ebextend(true, toConfig, hostConf);
        }

        // Advanced connection settings.
        var ak = eb.misc.absorbKey;
        ak(this, toConfig, "remoteEndpoint");
        ak(this, toConfig, "remotePort");
        ak(this, toConfig, "requestMethod");
        ak(this, toConfig, "requestScheme");
        ak(this, toConfig, "requestTimeout");
        ak(this, toConfig, "debuggingLog");
        ak(this, toConfig, "logger");
        ak(this, toConfig, "responseParser");
        ak(this, toConfig, "reqHeader");
        ak(this, toConfig, "reqBody");
    },

    /**
     * Initializes state and builds request
     * @param requestHeader
     * @param requestBody
     */
    build: function(requestHeader, requestBody){
        if (requestHeader) {
            this.reqHeader = requestHeader;
        }

        if (requestBody) {
            this.reqBody = requestBody;
        }
    },

    /**
     * Builds EB request.
     *
     * @param requestHeader
     * @param requestBody
     * @returns request body string.
     */
    doRequest: function(requestHeader, requestBody){
        if (!this.reqBody){
            this.build(requestHeader, requestBody);
        }

        var url = this.getApiUrl();
        var apiData = this.getApiRequestData();
        var ajaxSettings = {
            url: url,
            type: this.requestMethod,
            dataType: 'json',
            timeout: this.requestTimeout,
            data: this.requestMethod == eb.comm.REQ_METHOD_POST ? JSON.stringify(apiData) : null
        };

        // Extend ajax settings with user provided settings.
        ebextend(ajaxSettings, this.ajaxSettings || {});
        var ebc = this;

        // Do the remote call
        this._log("Sending remote request...");
        this.requestTime = new Date().getTime();

        var doneCb = function (data, textStatus, jqXHR) {
            ebc._requestFinished();
            ebc._log("Response status: " + textStatus);
            ebc._log("Raw response: " + JSON.stringify(data));

            // Process AJAX success. By default, response parsing is done. Subclass may modify this behavior.
            ebc.processAnswer(data, textStatus, jqXHR);
        };
        var failCb = function (jqXHR, textStatus, errorThrown) {
            ebc._requestFinished();
            ebc._log("Error: " + sprintf("Error: status=[%s], responseText: [%s], error: [%s], status: [%s] misc: %s",
                    jqXHR.status, jqXHR.responseText, errorThrown, textStatus, JSON.stringify(jqXHR)));

            // Process AJAX fail, subclass can modify behavior, hook something.
            ebc.processFail(jqXHR, textStatus, errorThrown);

        };
        var alwaysCb = function (data, textStatus, jqXHR) {
            // Process AJAX always, subclass can modify behavior, hook something.
            ebc.processAlways(data, textStatus, jqXHR);

        };

        // Do the request.
        if (typeof $ !== 'undefined') {
            this._requestJquery(ajaxSettings, doneCb, failCb, alwaysCb);
        } else {
            this._requestSuperAgent(ajaxSettings, doneCb, failCb, alwaysCb);
        }
    },

    _requestJquery: function(setting, successCb, failCb, alwaysCb){
        /*globals $:false */
        return $.ajax(setting)
            .done(successCb)
            .fail(failCb)
            .always(alwaysCb);
    },

    _requestSuperAgent: function(setting, successCb, failCb, alwaysCb){
        // http://visionmedia.github.io/superagent/
        var isPost = setting && setting.type == eb.comm.REQ_METHOD_POST;
        var req = isPost ? superagent.post(setting.url) : superagent.get(setting.url);

        // Cache bypassing, disabled by now, not needed with nonce. Plugin had some problems anyway...
        //req.use(superagentNoCache);

        if (isPost && setting.data){
            // Setting type causes preflight check with OPTIONS. Can cause problems with CORS.
            //  if server does not support OPTIONS request. Moreover, it duplicates the traffic / roundtrips.
            //req.type('application/json');
            req.send(setting.data);
        }

        if (setting.timeout){
            req.timeout(setting.timeout);
        }

        // Kick-off the request.
        req.end(function(err, res){
            var xhr = req && req.xhr ? req.xhr : {};
            if (err || !res.ok){
                alwaysCb(err.message, err.status, xhr);
                failCb(xhr, err.message, err);
            } else {
                alwaysCb(res.body, res.status, xhr);
                successCb(res.body, res.status, xhr);
            }
        });
    },

    /**
     * Request finished, measure time.
     * @private
     */
    _requestFinished: function(){
        this.requestTime = (new Date().getTime() - this.requestTime);
        this._log("Request finished in " + this.requestTime + " ms");
    },

    /**
     * Processing response from the server.
     *
     * @param data
     * @param textStatus
     * @param jqXHR
     */
    processAnswer: function(data, textStatus, jqXHR){
        this.rawResponse = data;
        try {
            var responseParser = this.getResponseParser();
            this.response = this.getResponseObject();
            this.response = responseParser.parse(data, this.response);

            if (responseParser.success()) {
                this._log("Processing complete, response: " + this.response.toString());
                if (this._doneCallback){
                    this._doneCallback(this.response, this, {
                        'jqXHR':jqXHR,
                        'textStatus':textStatus,
                        'response':this.response,
                        'requestObj':this
                    });
                }

            } else {
                this._log("Failure, status: " + this.response.toString());
                if (this._failCallback){
                    this._failCallback(eb.comm.status.PDATA_FAIL_RESPONSE_FAILED, {
                        'jqXHR':jqXHR,
                        'textStatus':textStatus,
                        'response':this.response,
                        'failType':eb.comm.status.PDATA_FAIL_RESPONSE_FAILED,
                        'requestObj':this
                    });
                }
            }

        } catch(e){
            this._log("Exception when processing the response: " + e);
            if (this._failCallback){
                this._failCallback(eb.comm.status.PDATA_FAIL_RESPONSE_PARSING, {
                    'jqXHR':jqXHR,
                    'textStatus':textStatus,
                    'failType':eb.comm.status.PDATA_FAIL_RESPONSE_PARSING,
                    'requestObj':this,
                    'parseException':e
                });
            }

            throw e;
        }
    },

    /**
     * To be overriden.
     * Called on AJAX fail.
     *
     * @param jqXHR
     * @param textStatus
     * @param errorThrown
     */
    processFail: function(jqXHR, textStatus, errorThrown){
        if (this._failCallback) {
            this._failCallback(eb.comm.status.PDATA_FAIL_CONNECTION, {
                'jqXHR':jqXHR,
                'textStatus':textStatus,
                'errorThrown':errorThrown,
                'failType':eb.comm.status.PDATA_FAIL_CONNECTION,
                'requestObj': this
            });
        }
    },

    /**
     * To be overriden.
     * Called on AJAX always.
     *
     * @param data
     * @param textStatus
     * @param jqXHR
     */
    processAlways: function(data, textStatus, jqXHR){
        if (this._alwaysCallback) {
            this._alwaysCallback(this, {
                'responseRawData':data,
                'textStatus':textStatus,
                'jqXHR':jqXHR,
                'requestObj': this
            });
        }
    },

    /**
     * Returns remote API URL to query with Ajax.
     * According to current request settings.
     * Note: Request has to be built when calling this function.
     *
     * @returns {*}
     */
    getApiUrl: function(){
        return sprintf("%s://%s:%d/",
            this.requestScheme,
            this.remoteEndpoint,
            this.remotePort);
    },

    /**
     * Returns Ajax request data.
     * According to current request settings.
     * Note: Request has to be built when calling this function.
     *
     * @returns {*}
     */
    getApiRequestData: function(){
        return this.reqBody;
    },

    /**
     * Returns response parser when is needed. May lazily initialize parser.
     * Override point.
     *
     * @returns {*}
     */
    getResponseParser: function(){
        this.responseParser = new eb.comm.responseParser();
        this.responseParser.debuggingLog = true;
        this.responseParser.logger = this.logger;
        return this.responseParser;
    },

    /**
     * Returns respone object to be used by the response parser.
     * Enables to specify a subclass of the original response class.
     */
    getResponseObject: function(){
        return new eb.comm.response();
    },

    /**
     * Returns raw EB request for raw socket transport method.
     * For debugging & verification.
     *
     * @returns {string}
     */
    getSocketRequest: function(){
        this._socketRequest = {};
        ebextend(true, this._socketRequest, this.reqHeader || {});
        ebextend(true, this._socketRequest, this.reqBody || {});
        return this._socketRequest;
    },

    /**
     * Logger wrapper. Allowing to log messages both to console and provided logger.
     * @param x message to log.
     * @private
     */
    _log:  function(x) {
        if (!this.debuggingLog){
            return;
        }

        if (console && console.log){
            console.log(x);
        }

        if (this.logger){
            this.logger(x);
        }
    }
};

/**
 * API request using the connector.
 * Standard request with
 *   - API version,
 *   - API Key,
 *   - API lower 4 bytes identifier (e.g., user object id),
 *   - call function,
 *   - nonce
 *
 * @param {String} options.apiKey
 * @param {String} options.uoId
 * @param {String} [options.uoType]
 */
eb.comm.apiRequest = function(options){
    options = options || {};
    this.apiKey = options.apiKey;
    this.uoId = options.uoId;
    this.uoType = options.uoType;
};
eb.comm.apiRequest.inheritsFrom(eb.comm.connector, {
    objName: "apiRequest",

    /**
     * Function to call
     * @input
     * @default ProcessData
     */
    callFunction: "ProcessData",

    /**
     * User API key
     * @input
     */
    apiKey: undefined,

    /**
     * Lower 4 API bytes to use for api token. UserObject Id.
     * @input
     */
    uoId: undefined,

    /**
     * User object type for API call.
     */
    uoType: undefined,

    /**
     * Version of EB API.
     * @input
     * @default 1.0
     */
    apiVersion: "1.0",

    /**
     * Nonce generated for the request.
     * @input
     * @output
     */
    nonce: undefined,

    /**
     * Composite API key for the request.
     * Generated before request is sent.
     * @private
     */
    _apiKeyReq: "",

    /**
     * Builds API key token.
     * Consists of apiKey and low4B identifier.
     * Can be specified by parameters or currently set values are set.
     * Result is returned and set to the property.
     *
     * @param apiKey
     * @param uoId  integer or hex-coded string.
     * @param uoType  integer or hex-coded string.
     */
    buildApiBlock: function(apiKey, uoId, uoType){
        apiKey = apiKey || this.apiKey;
        uoId = eb.misc.def(uoId, this.uoId);
        uoType = eb.misc.def(uoType, this.uoType);
        this._apiKeyReq = eb.comm.getUoHandle(apiKey, uoId, uoType);
        return this._apiKeyReq;
    },

    /**
     * Builds standard request header from existing fields.
     */
    buildReqHeader: function() {
        this.reqHeader = {
            objectid:this._apiKeyReq,
            function:this.callFunction,
            nonce:this.getNonce(),
            version:this.apiVersion
        };
        return this.reqHeader;
    },

    /**
     * Returns currently set nonce.
     * Generates a new one if is undefined.
     * @returns {*}
     */
    getNonce: function(){
        if (!this.nonce){
            return this.genNonce();
        }

        return this.nonce;
    },

    /**
     * Generates new nonce, sets it as a current nonce for the request.
     * @returns {string|*|string}
     */
    genNonce: function(){
        this.nonce = eb.misc.genHexNonce(16);
        return this.nonce;
    },

    /**
     * Process configuration from the config object.
     * @param {Object} [configObject] json object with the configuration.
     * @param {String} [configObject.handle] handle returned from createUO. Uses eb.comm.parseHandle to parse into
     *        properties apiKey, uoId, uoType
     * @param {String|Number} [configObject.uoId] user object ID
     * @param {String|Number} [configObject.uoType] user object type
     * @param {String} [configObject.apiKey] user object type
     * @param {String|Array} [configObject.nonce] anti-replay nonce may be defined, if not, is generated at random
     */
    configure: function(configObject){
        if (!configObject){
            this._log("Invalid config object");
            return;
        }

        // Parse handle
        var toConfig = configObject;
        if ("handle" in configObject){
            var hnd = eb.comm.parseHandle(configObject.handle);
            toConfig = ebextend(true, toConfig, hnd);
        }

        // Backward compatibility
        if ("apiKeyLow4Bytes" in toConfig && !("uoId" in toConfig)){
            toConfig.uoId = toConfig.apiKeyLow4Bytes;
        }

        // Configure with parent.
        eb.comm.apiRequest.superclass.configure.call(this, toConfig);

        // Configure this.
        var ak = eb.misc.absorbKey;
        ak(this, toConfig, "callFunction");
        ak(this, toConfig, "apiKey");
        ak(this, toConfig, "uoId");
        ak(this, toConfig, "uoType");
        ak(this, toConfig, "nonce");
    },

    /**
     * Returns remote API URL to query with Ajax.
     * According to current request settings.
     * Note: Request has to be built when calling this function.
     *
     * @returns {*}
     */
    getApiUrl: function(){
        if (this.requestMethod == eb.comm.REQ_METHOD_POST || (this.requestMethod == eb.comm.REQ_METHOD_GET && !this.reqBody)){
            return sprintf("%s://%s:%d/%s/%s/%s/%s",
                this.requestScheme,
                this.remoteEndpoint,
                this.remotePort,
                this.apiVersion,
                this._apiKeyReq,
                this.callFunction,
                this.getNonce());

        } else if (this.requestMethod == eb.comm.REQ_METHOD_GET){
            return sprintf("%s://%s:%d/%s/%s/%s/%s%s",
                this.requestScheme,
                this.remoteEndpoint,
                this.remotePort,
                this.apiVersion,
                this._apiKeyReq,
                this.callFunction,
                this.getNonce(),
                this.reqBody !== undefined ? ("/" + JSON.stringify(this.reqBody)) : "");

        } else {
            throw new eb.exception.invalid("Invalid configuration, unknown method: " + this.requestMethod);
        }
    },

    /**
     * Returns Ajax request data.
     * According to current request settings.
     * Note: Request has to be built when calling this function.
     *
     * @returns {*}
     */
    getApiRequestData: function(){
        if (this.requestMethod == eb.comm.REQ_METHOD_POST) {
            return this.reqBody;
        } else {
            return {};
        }
    },

    /**
     * Initializes state and builds request
     * @param requestHeader
     * @param requestBody
     */
    build: function(requestHeader, requestBody){
        if (requestHeader.apiKey && requestHeader.uoId){
            this.buildApiBlock(requestHeader.apiKey, requestHeader.uoId, requestHeader.uoType);
        } else {
            this.buildApiBlock();
        }

        if (requestBody){
            this.reqBody = requestBody;
        }

        if (requestHeader){
            this.reqHeader = requestHeader;
        }

        this.buildReqHeader();
    },
});

/**
 * Process data request to the EB.
 * @param {String} [options.apiKey]
 * @param {String|bitArray} [options.aesKey]
 * @param {String|bitArray} [options.macKey]
 */
eb.comm.processData = function(options){
    options = options || {};
    this.apiKey = options.apiKey || "";
    this.aesKey = options.aesKey || "";
    this.macKey = options.macKey || "";
    this.callFunction = "ProcessData";
};
eb.comm.processData.inheritsFrom(eb.comm.apiRequest, {
    /**
     * AES communication encryption key, hexcoded string.
     * @input
     */
    aesKey: "",

    /**
     * AES MAC communication key, hexcoded string.
     * @input
     */
    macKey: "",

    /**
     * Type of the data request.
     * PLAINAES for AES keys, RSA2048 for RSA-2048 keys.
     *
     * @input
     * @default PLAINAES
     */
    callRequestType: "PLAINAES",

    /**
     * Request builder used to build the request.
     * @output
     */
    processDataRequestBodyBuilder: null,

    /**
     * Request block generated by request builder.
     * @private
     */
    _requestBlock: "",

    /**
     * Process configuration from the config object.
     * @param configObject java object with the configuration.
     */
    configure: function(configObject){
        if (!configObject){
            this._log("Invalid config object");
            return;
        }

        // Support also some commonly used aliases in the configuration.
        var toConfig = configObject;
        if ("userObjectId" in configObject){
            toConfig = ebextend(true, toConfig, {uoId : configObject.userObjectId});
        }
        if ("encKey" in configObject){
            toConfig = ebextend(true, toConfig, {aesKey : configObject.encKey});
        }

        // Configure with parent.
        eb.comm.processData.superclass.configure.call(this, toConfig);

        // Configure this.
        var ak = eb.misc.absorbKey;
        ak(this, toConfig, "aesKey");
        ak(this, toConfig, "macKey");
        ak(this, toConfig, "callRequestType");
    },

    /**
     * Initializes state and builds request
     * @param plainData
     * @param requestData
     */
    build: function(plainData, requestData){
        this._log("Building request body");

        // Request header data.
        this.buildApiBlock();
        this.buildReqHeader();

        // Build a new EB request.
        this.processDataRequestBodyBuilder = new eb.comm.processDataRequestBodyBuilder();
        this.processDataRequestBodyBuilder.aesKey = this.aesKey;
        this.processDataRequestBodyBuilder.macKey = this.macKey;
        this.processDataRequestBodyBuilder.userObjectId = this.uoId;
        this.processDataRequestBodyBuilder.reqType = this.callRequestType;
        this.processDataRequestBodyBuilder.debuggingLog = this.debuggingLog;
        this.processDataRequestBodyBuilder.logger = this.logger;
        this.processDataRequestBodyBuilder.nonce = this.getNonce();

        this._requestBlock = this.processDataRequestBodyBuilder.build(plainData, requestData);
        this.reqBody = {data : this._requestBlock};

        var nonce = this.getNonce();
        var url = this.getApiUrl();
        var apiData = this.getApiRequestData();

        this._log("Nonce: " + nonce);
        this._log("URL: " + url + ", method: " + this.requestMethod);
        this._log("UserData: " + JSON.stringify(apiData));
        this._log("SocketReq: " + JSON.stringify(this.getSocketRequest()));
    },

    /**
     * Builds EB request.
     *
     * @param requestHeader
     * @param requestBody
     * @returns request body string.
     */
    doRequest: function(requestHeader, requestBody){
        if (!this.reqBody){
            this.build(requestHeader, requestBody);
        }

        eb.comm.processData.superclass.doRequest.call(this);
    },

    /**
     * Returns remote API URL to query with Ajax.
     * According to current request settings.
     * Note: Request has to be built when calling this function.
     *
     * @returns {*}
     */
    getApiUrl: function(){
        if (this.requestMethod == eb.comm.REQ_METHOD_POST){
            return sprintf("%s://%s:%d/%s/%s/%s/%s",
                this.requestScheme,
                this.remoteEndpoint,
                this.remotePort,
                this.apiVersion,
                this._apiKeyReq,
                this.callFunction,
                this.getNonce());

        } else if (this.requestMethod == eb.comm.REQ_METHOD_GET){
            return sprintf("%s://%s:%d/%s/%s/%s/%s/%s",
                this.requestScheme,
                this.remoteEndpoint,
                this.remotePort,
                this.apiVersion,
                this._apiKeyReq,
                this.callFunction,
                this.getNonce(),
                this.reqBody.data);

        } else {
            throw new eb.exception.invalid("Invalid configuration, unknown method: " + this.requestMethod);
        }
    },

    /**
     * Returns Ajax request data.
     * According to current request settings.
     * Note: Request has to be built when calling this function.
     *
     * @returns {*}
     */
    getApiRequestData: function(){
        if (this.requestMethod == eb.comm.REQ_METHOD_POST) {
            return this.reqBody;
        } else {
            return {};
        }
    },

    /**
     * Returns response parser when is needed. May lazily initialize parser.
     * Override point.
     *
     * @returns {*}
     */
    getResponseParser: function(){
        this.responseParser = new eb.comm.processDataResponseParser();
        this.responseParser.debuggingLog = this.debuggingLog;
        this.responseParser.logger = this.logger;
        this.responseParser.aesKey = this.aesKey;
        this.responseParser.macKey = this.macKey;
        return this.responseParser;
    }
});

/**
 * Request obtaining import public keys.
 */
eb.comm.getPubKey = function(){
    this.callFunction = "GetImportPublicKey";
};
eb.comm.getPubKey.inheritsFrom(eb.comm.apiRequest, {
    objName: "getPubKey",

    /**
     * Initializes state and builds request
     */
    build: function(){
        this._log("Building request body");

        // Request header data.
        this.buildApiBlock();
        this.buildReqHeader();
        this.reqBody = {};

        var nonce = this.getNonce();
        var url = this.getApiUrl();
        this._log("Nonce generated: " + nonce);
        this._log("URL: " + url + ", method: " + this.requestMethod);
        this._log("SocketReq: " + JSON.stringify(this.getSocketRequest()));
    },

    /**
     * Returns response parser when is needed. May lazily initialize parser.
     * Override point.
     *
     * @returns {*}
     */
    getResponseParser: function(){
        // Generic parser with given parsing function.
        var pubKeyParser = new eb.comm.responseParser();
        pubKeyParser.parsingFunction(function(data, resp, parser){
            var response = new eb.comm.pubKeyResponse(resp);

            /**
             * Response:
             * {"function":"GetImportPublicKey","result":[
             * {"certificate":null,"id":263,"type":"rsa","key":"81 00 03 01 00 01 82 01 00 e1 e0 6b 76 f9 7b cd 82 7c 98 cc 3b 41 a8 50 40 cc dc 61 cf 72 58 14 fd b9 e9 5f 53 06 29 12 e9 39 b1 3c f1 ce 27 d0 7b 44 78 57 7a 20 9c ff db de a2 90 29 19 c0 87 08 8f 85 d5 ed 1d 0b 0c dc ef d8 23 b6 49 71 4f 69 95 31 d9 b8 10 08 af 63 5e a9 79 67 82 fe 3c 40 3c 0e 5d e2 15 58 78 06 f3 0e 16 09 4d a0 16 05 89 e9 80 1c ba f4 0e 63 fd 2d 72 cb 85 cb 7f c1 9a 37 7b 0f a9 2e 7d 90 8e 6a 69 aa bc 4c 5b a2 2d 32 e5 58 7e 0e d8 12 b4 c1 62 66 84 98 fd e5 54 08 93 c1 c0 88 41 51 60 93 93 d8 cc cd ee 3e eb 88 ae 91 24 32 16 b2 26 92 73 f9 a5 23 b9 5c cf e5 b1 f9 e5 4f d2 4f 73 77 a2 ab d7 c6 43 9e c4 60 97 c4 70 1e 58 c2 49 33 02 2d 43 8b 77 67 3c 30 0e a6 81 e4 73 d2 46 18 f9 79 40 3d a6 79 dd 5c 3c e0 b7 4c 16 a9 5c 96 47 40 7c 2c dc 11 3b 92 75 44 ec d8 c6 95 "},
             * {"certificate":null,"id":264,"type":"rsa","key":"81 00 03 01 00 01 82 01 00 e1 e0 6b 76 f9 7b cd 82 7c 98 cc 3b 41 a8 50 40 cc dc 61 cf 72 58 14 fd b9 e9 5f 53 06 29 12 e9 39 b1 3c f1 ce 27 d0 7b 44 78 57 7a 20 9c ff db de a2 90 29 19 c0 87 08 8f 85 d5 ed 1d 0b 0c dc ef d8 23 b6 49 71 4f 69 95 31 d9 b8 10 08 af 63 5e a9 79 67 82 fe 3c 40 3c 0e 5d e2 15 58 78 06 f3 0e 16 09 4d a0 16 05 89 e9 80 1c ba f4 0e 63 fd 2d 72 cb 85 cb 7f c1 9a 37 7b 0f a9 2e 7d 90 8e 6a 69 aa bc 4c 5b a2 2d 32 e5 58 7e 0e d8 12 b4 c1 62 66 84 98 fd e5 54 08 93 c1 c0 88 41 51 60 93 93 d8 cc cd ee 3e eb 88 ae 91 24 32 16 b2 26 92 73 f9 a5 23 b9 5c cf e5 b1 f9 e5 4f d2 4f 73 77 a2 ab d7 c6 43 9e c4 60 97 c4 70 1e 58 c2 49 33 02 2d 43 8b 77 67 3c 30 0e a6 81 e4 73 d2 46 18 f9 79 40 3d a6 79 dd 5c 3c e0 b7 4c 16 a9 5c 96 47 40 7c 2c dc 11 3b 92 75 44 ec d8 c6 95 "}]
             * ,"status":"9000","statusdetail":"(OK)SW_STAT_OK","version":"1.0"}
             */
            if (!data.result || !data.result.length) {
                parser._log("Result is not an array");
                return;
            }

            response.keys = [];
            var index, len, cur, cKey;
            for (index = 0, len = data.result.length; index < len; ++index) {
                cur = data.result[index];
                cKey = new eb.comm.pubKey();
                if (!("id" in cur && "key" in cur)){
                    continue;
                }

                cKey.id = cur.id;
                cKey.type = cur.type;
                if ("certificate" in cur && cur.certificate){
                    var noSpaceCrt = cur.certificate.replace(/\s+/g,'');
                    cKey.certificate = sjcl.codec.hex.toBits(noSpaceCrt);
                }

                if ("key" in cur && cur.key){
                    var noSpaceKey = cur.key.replace(/\s+/g,'');
                    cKey.key = sjcl.codec.hex.toBits(noSpaceKey);
                }

                response.keys.push(cKey);
            }
            return response;
        });

        this.responseParser = pubKeyParser;
        return this.responseParser;
    }
});

/**
 * HOTP feature.
 */
eb.comm.hotp = {
    // Template for generation of new user context.
    // USER_AUTH_CTX structure: version 1B | user_id 8B | flags 4B | #total_failed_tries 1B | #max_total_failed_tries 1B | TLV_auth_method1 | ... | TLV_auth_method_n |
    //                   VR    USER-ID-8B     flags   #e #m
    ctxTemplateUsr:     '01         %s       00000000 00 04',

    // HOTP method:      tt  len cf mf HOTP 8B counter  ct  Dg  Ln Secret - template
    ctxTemplateHotp:    '3f 001d 00 03 0000000000000000 02 %02x 10 11223344556677881122334455667788',

    // Passwd method:    tt len  cf mf hl   password hash
    ctxTemplatePasswd:  '40 %04x 00 03 %02x %s',

    // VR - version
    // #e - total failed entries
    // #m - max total failed entries
    // tt - auth method type. 0x3f = HOTP, 0x40 = password auth.
    // len - overall auth record length
    // Dg - digits
    // Ln - secret length
    // cf - current fails
    // mf - maximum number of fails
    // hl - hash length

    // Constants
    TLV_TYPE_USERAUTHCONTEXT: 0xa3,
    TLV_TYPE_NEWAUTHCONTEXT: 0xa8,
    TLV_TYPE_UPDATEAUTHCONTEXT: 0xa7,
    TLV_TYPE_HOTPCODE: 0xa5,
    TLV_TYPE_PASSWORDHASH: 0xa4,
    USERAUTHCTX_MAIN_USERID_LENGTH: 8,
    USERAUTH_FLAG_HOTP: 0x0001,
    USER_AUTH_TYPE_HOTP: 63,
    USERAUTH_FLAG_PASSWD: 0x0002,
    USER_AUTH_TYPE_PASSWD: 64,
    USERAUTH_FLAG_GLOBALTRIES: 0x0004,
    USER_AUTH_TYPE_GLOBALTRIES: 62,

    HOTP_DIGITS_DEFAULT: 6,

    /**
     * Builds generalized context template from the options.
     * May contain two authentization methods at the moment, HOTP, Password.
     * @param options
     *      userId:  user ID aditional entropy. By default 0000000000000001
     *      methods: flags for methods to include in context. USERAUTH_FLAG_HOTP, USERAUTH_FLAG_PASSWD.
     *      hotp: {digits}: hotp digits in the template. HOTP code length.
     *      passwd: {hash}: password hash used for authentication.
     */
    getCtxTemplate: function(options){
        var defaults = {
            userId: eb.comm.hotp.userIdToHex("01"),
            methods: eb.comm.hotp.USERAUTH_FLAG_HOTP,
            hotp:{
                digits: eb.comm.hotp.HOTP_DIGITS_DEFAULT
            },
            passwd:{
                hash: undefined
            }
        };

        options = ebextend(true, defaults, options || {});
        var useHotp = options && ((options.methods & eb.comm.hotp.USERAUTH_FLAG_HOTP) > 0);
        var usePass = options && ((options.methods & eb.comm.hotp.USERAUTH_FLAG_PASSWD) > 0);

        var userId = eb.comm.hotp.userIdToHex(options && options.userId);

        // Build base context.
        var ctx = sprintf(this.ctxTemplateUsr, userId);

        // Add HOTP method, if desired.
        if (useHotp){
            var digits = options && options.hotp && options.hotp.digits;
            ctx += sprintf(this.ctxTemplateHotp, digits);
        }

        // Add Password method, if desired.
        if (usePass){
            var hash = options && options.passwd && options.passwd.hash;
            if (hash === undefined || hash.length === 0) {
                throw new eb.exception.invalid("Password auth method specified, empty hash");
            }

            hash = eb.misc.padHexToEven(eb.misc.inputToHex(hash));
            var hashLen = hash.length / 2;
            var totalLen = 3 + hashLen;

            ctx += sprintf(this.ctxTemplatePasswd, totalLen, hashLen, hash);
        }

        return sjcl.codec.hex.toBits(ctx.replace(/ /g,''));
    },

    /**
     * Encrypts HOTP CTX template with random key & MACs with random key to obtain encrypted
     * template blob. Required for new user HOTPCTX init.
     *
     * @param tpl
     * @returns {*}
     */
    prepareUserContext: function(tpl){
        var randomEncKey = sjcl.random.randomWords(8);
        var randomMacKey = sjcl.random.randomWords(8);

        var aes = new sjcl.cipher.aes(randomEncKey);
        var aesMac = new sjcl.cipher.aes(randomMacKey);
        var hmac = new sjcl.misc.hmac_cbc(aesMac, 16, eb.padding.empty);

        // Padding of the TPL.
        tpl = eb.padding.pkcs7.pad(tpl);

        // IV is null, nonce in the first block is kind of IV.
        var IV = [0, 0, 0, 0];
        var encryptedData = sjcl.mode.cbc.encrypt(aes, tpl, IV, [], true);
        var hmacData = hmac.mac(encryptedData);

        return sjcl.bitArray.concat(encryptedData, hmacData);
    },

    /**
     * Converts HOTP number given as string to hex-coded array.
     * Used when authenticating via HOTP code.
     *
     * Warning: does not perform radix change. 12345678 -> d2h(12)|d2h(34)|d2h(56)|d2h(78) = 0c22384e
     * d2h(12345678) = 0BC614E
     *
     * @param hotpCode numeric authentication code coded as string in decimal.
     * @param length HOTP code length. Default = 8. Usually 6,8,10,12
     * @ref: intToExpandedShortByteArray()
     */
    hotpCodeToHexCoded: function(hotpCode, length){
        length = length || eb.comm.hotp.HOTP_DIGITS_DEFAULT;
        var inputCode = "000000000000000000000000000" + hotpCode;
        var i,idx,cur,curNum,codeLength = inputCode.length;
        var result = "";
        for(i=0; i<(length+1)/2; i++){
            idx = codeLength-(i+1)*2;
            cur = inputCode.substring(idx, idx + 2);
            curNum = parseInt(cur, 10);
            result = sprintf("%04X", curNum) + result;
        }
        return result;
    },

    /**
     * Function used to normalize user ID bitArray representation - 2 words width.
     * @param x
     */
    userIdBitsNormalize: function(x){
        var ln = x.length;
        if (ln === 2){
            return x;
        } else if (ln === 0){
            return [0,0];
        } else if (ln === 1){
            return [0, x[0]];
        } else {
            return [x[0], x[1]];
        }
    },

    /**
     * Converts user id argument to the 64bit SJCL bitArray.
     * @param x
     *      if x is a number, it is converted to SJCL bitArray. Warning, 32bit numbers are supported only.
     *      if x is a string, it is considered as hex coded string.
     *      if x is an array it is considered as SJCL bitArray.
     */
    userIdToBits: function(x){
        var ln;
        if (typeof(x) === 'number'){
            return eb.comm.hotp.userIdBitsNormalize([x]);

        } else if (typeof(x) === 'string') {
            x = x.trim();
            ln = x.length;
            if (ln > 16 || ln === 0 || !(x.match(/^[0-9A-Fa-f]+$/))){
                throw new eb.exception.invalid("User ID string invalid");
            }

            return eb.comm.hotp.userIdBitsNormalize(sjcl.codec.hex.toBits(x));

        } else {
            return eb.comm.hotp.userIdBitsNormalize(x);

        }
    },

    /**
     * Converts user id argument to the hexcoded string coding 8 bytes.
     * @param x -
     *      if x is a number, will be converted to a hex string. Warning, 32bit numbers are supported only.
     *      if x is a string, it is considered as hex coded string. It is padded to 8 bytes.
     *      if x is an array it is considered as SJCL bitArray.
     */
    userIdToHex: function(x){
        var tmp,ln;
        if (typeof(x) === 'number'){
            // number
            return sprintf("%016x", x);

        } else if (typeof(x) === 'string') {
            // hex-coded string
            x = x.trim();
            ln = x.length;
            if (ln > 16 || ln === 0 || !(x.match(/^[0-9A-Fa-f]+$/))){
                throw new eb.exception.invalid("User ID string invalid");
            }

            return ln < 16 ? ('0'.repeat(16-ln)) + x : x;

        } else {
            // SJCL bitArray
            tmp = sjcl.codec.hex.fromBits(x);
            ln = tmp.length;
            if (ln > 16){
                throw new eb.exception.invalid("User ID string invalid");
            }
            return ln < 16 ? ('0'.repeat(16-ln)) + tmp : tmp;
        }
    },

    /**
     * Utility function to compute HOTP value, returned as string coded in decimal base.
     * @see https://tools.ietf.org/html/rfc4226
     * @param key           bitArray key | hexcoded key
     * @param ctr           8byte HOTP counter. bitArray or hexcoded string or numeric
     * @param length        length of the HOTP code.
     */
    hotpCompute: function(key, ctr, length){
        var hmac = new sjcl.misc.hmac(eb.misc.inputToBits(key), sjcl.hash.sha1);

        // Ctr is 8 byte counter, big endian coded. Make sure it has correct length.
        var ctrBits = eb.misc.inputToBits(ctr);
        var ctrHex = eb.misc.inputToHex(ctr).trim();
        var ctrHexLn = ctrHex.length;
        if (ctrHexLn > 16){
            throw new eb.exception.invalid("Counter value is too big");

        } else if (ctrHexLn < 16){
            ctrHex = ('0'.repeat(16-ctrHexLn)) + ctrHex;
            ctrBits = sjcl.codec.hex.toBits(ctrHex);
        }

        // 1. step, compute HMAC.
        var hs = hmac.mac(ctrBits);

        // 2. dynamic truncation. hs has 160 bits, take lower 4.
        // 0 <= offSet <= 15
        var offset = sjcl.bitArray.extract(hs, 156, 4) & 0xf;

        // Take low 31 bits from hs[offset]..hs[offset+3]
        // 3. Convert to a number.
        var snum = sjcl.bitArray.extract(hs, offset*8+1, 31);

        // 4. mod length. 31 bit => maximum length is 8. 9 makes no real sense.
        return snum % (Math.pow(10, length));
    },

    /**
     * Generates QR code link.
     * @param secret
     * @param options - additional options affecting QR code link generation.
     *      label: user name for HOTP auth,
     *      web: HOTP login gateway identification,
     *      issuer: HOTP account identification (e.g., enigmabridge, facebook, gmail, ....),
     *      ctr: HOTP counter,
     *      stripPadding: removes '=' from secret in the link, fixing problem with some HOTP authenticators.
     *
     * @returns {*}
     */
    hotpGetQrLink: function(secret, options){
        var defaults = {
            label: "EB",
            web: "enigmabridge.com",
            issuer: undefined,
            ctr: 0,
            digits: undefined,
            stripPadding: false
        };

        options = ebextend(defaults, options || {});
        var label = options && options.label;
        var web = options && options.web;
        var issuer = options && options.issuer;
        var ctr = options && options.ctr;
        var stripPadding = options && options.stripPadding;
        var digits = options && options.digits;

        // Construct the secret.
        var secretBits = eb.misc.inputToBits(secret);
        var secret32 = sjcl.codec.base32.fromBits(secretBits);
        if (stripPadding){
            secret32 = secret32.replace(/=/g,'');
        }

        return sprintf("otpauth://hotp/%s:%s?secret=%s%s%s%s",
            encodeURIComponent(label),
            encodeURIComponent(web),
            secret32,
            issuer !== undefined ? "&issuer="+encodeURIComponent(issuer) : "",
            ctr !== undefined ? "&counter="+ctr : "",
            digits !== undefined ? "&digits="+digits : ""
        );
    },

    /**
     * User context holder constructor.
     * Can be used by a client to hold all important data about user for HOTP.
     */
    hotpUserAuthCtxInfo: function(){

    },

    /**
     * HOTP general response constructor.
     * @extends eb.comm.response
     */
    hotpResponse: function(){

    },

    /**
     * General HOTP response parser constructor.
     */
    generalHotpParser: function(){

    },

    /**
     * New HOTPCTX request builder constructor.
     * @param options.
     *      userId:  user ID aditional entropy. By default 0000000000000001
     *      methods: flags for methods to include in context. USERAUTH_FLAG_HOTP, USERAUTH_FLAG_PASSWD.
     *      hotp: {digits}: hotp digits in the template. HOTP code length.
     *      passwd: {hash}: password hash used for authentication.
     */
    newHotpUserRequestBuilder: function(options){
        this.configure(options);
    },

    /**
     * New HOTPCTX response parser constructor.
     */
    newHotpUserResponseParser: function(){

    },

    /**
     * HOTP user authentication request builder constructor.
     */
    hotpUserAuthRequestBuilder: function(){

    },

    /**
     * HOTP user authentication response parser constructor.
     */
    hotpUserAuthResponseParser: function(){

    },

    /**
     * Generator of update auth context request constructor.
     */
    updateAuthContextRequestBuilder: function(options){
        this.configure(options);
    },

    /**
     * Auth context update response parser constuctor.
     */
    updateAuthContextResponseParser: function(options){

    },

    /**
     * Convenience function for building HOTP auth request.
     * @param userId hex coded user ID, 8B.
     * @param authCode hex coded auth code.
     * @param userCtx user context, bitArray.
     * @param method auth operation to perform, default=TLV_TYPE_HOTPCODE
     */
    getUserAuthRequest: function(userId, authCode, userCtx, method){
        var builder = new eb.comm.hotp.hotpUserAuthRequestBuilder(userId);
        return builder.build({
            userId: userId,
            authCode: authCode,
            userCtx: userCtx,
            authOperation: method || eb.comm.hotp.TLV_TYPE_HOTPCODE
        });
    },

    /**
     * General HOTP process data request constructor.
     * @param uo    UserObject to use for the call.
     * @abstract
     * @private
     */
    hotpRequest: function(uo){
        var av = eb.misc.absorbValue;
        av(this, uo, 'uo');
    },

    /**
     * Request for new HOTP CTX constructor.
     * @param options
     *      hotp:
     *      {
     *          uo    UserObject to use for the call.
     *          userId user ID to create context for.
     *          hotpLength number of digits
     *      }
     */
    newHotpUserRequest: function(options){
        options = options || {};
        this.configure(options);
    },

    /**
     * Request to authenticate HOTP user constructor.
     * @param options
     *      hotp:
     *      {
     *          uo UserObject to use for the call.
     *          userId
     *          userCtx
     *          hotpCode
     *          passwd
     *      }
     */
    authHotpUserRequest: function(options){
        options = options || {};
        this.configure(options);
    },

    /**
     * Request to update auth context constructor.
     * @param options
     *      hotp:
     *      {
     *          uo UserObject to use for the call.
     *          userId
     *          userCtx
     *          TODO: complete
     *      }
     */
    authContextUpdateRequest: function(options){
        options = options || {};
        this.configure(options);
    }

};

/**
 * HOTP user context holder.
 */
eb.comm.hotp.hotpUserAuthCtxInfo.inheritsFrom(eb.comm.base, {
    /**
     * User Auth context blob.
     * Server parameter.
     *
     * Authentication:
     *  - caller fills in with given user context. EB authenticates against this encrypted blob.
     *  - after authentication, this blob is updated by the server.
     *
     * New HOTPCTX():
     *  - caller leaves undefined.
     *  - server generates new user context. Server stores this value.
     */
    userCtx: undefined,

    /**
     * User ID to authenticate / create new HOTPCTX for.
     * Server parameter.
     */
    userId: undefined,

    /**
     * HOTP key - after new HOTPCTX(), server provides symmetric key for generating HOTP codes.
     * Used to generate HOTP on the client side. HOTP client is initialized with this value.
     * Client parameter.
     *
     * @output
     */
    hotpKey: undefined,

    /**
     * HOTP counter - counter value to generate HOTP codes on the client side.
     * Client parameter.
     *
     * Should be increased by each successful attempt on the client side.
     * By default is 0.
     */
    hotpCounter: 0,

    /**
     * HOTP code length. Length of the HOTP code in decimal digits.
     * Reasonable values: 6,7,8.
     */
    hotpCodeLength: undefined,

    /**
     * Auth password hash.
     */
    userPasswdHash: undefined
});

/**
 * HOTP EB response.
 */
eb.comm.hotp.hotpResponse.inheritsFrom(eb.comm.processDataResponse, {
    /**
     * bitArray with HOTP user context blob.
     */
    hotpUserCtx: undefined,

    /**
     * bitArray with UserID from the response.
     * Filled in after match from given user ID has been confirmed (if given).
     */
    hotpUserId: undefined,

    /**
     * bitArray with HOTP key returned in new HOTPCTX()
     */
    hotpKey: undefined,

    /**
     * Numeric result of the auth ProcessData call.
     */
    hotpStatus: undefined,

    /**
     * If true, whole HOTP response was parsed successfully.
     * In auth request it indicates context can be updated successfully.
     * Flag added by the response parser.
     * If false, exception was probably thrown during parsing.
     */
    hotpParsingSuccessful: false,

    /**
     * If true, server should update its user ctx for given user.
     * Flag added by the response parser.
     * If request fails from some reason, server still may need to update context - e.g., to
     * store fail counter.
     */
    hotpShouldUpdateCtx: false,

    toString: function(){
        return sprintf("HOTPResponse{hotpStatus=0x%04X, userId: %s, hotpKeyLen: %s, UserCtx: %s, parsingOk: %s, sub:{%s}}",
            this.hotpStatus,
            this.hotpUserId !== undefined ? sjcl.codec.hex.fromBits(eb.comm.hotp.userIdToBits(this.hotpUserId)) : 'undefined',
            this.hotpKey !== undefined ? sjcl.bitArray.bitLength(this.hotpKey) : 'undefined',
            this.hotpUserCtx !== undefined ? sjcl.codec.hex.fromBits(this.hotpUserCtx) : 'undefined',
            this.hotpParsingSuccessful,
            eb.comm.hotp.hotpResponse.superclass.toString.call(this)
        );
    }
});

/**
 * new HOTP user request builder.
 */
eb.comm.hotp.newHotpUserRequestBuilder.inheritsFrom(eb.comm.base, {
    defaults: {
        userId: undefined,
        methods: eb.comm.hotp.USERAUTH_FLAG_HOTP,
        hotp:{
            digits: eb.comm.hotp.HOTP_DIGITS_DEFAULT
        },
        passwd:{
            hash: undefined
        }
    },

    /**
     * Configures local object with the preferences.
     * @param options
     *      userId:  user ID aditional entropy. By default 0000000000000001
     *      methods: flags for methods to include in context. USERAUTH_FLAG_HOTP, USERAUTH_FLAG_PASSWD.
     *      hotp: {digits}: hotp digits in the template. HOTP code length.
     *      passwd: {hash}: password hash used for authentication.
     */
    configure: function(options){
        if (options) {
            this.defaults = ebextend(true, this.defaults, options || {});
        }
    },

    /**
     * New HOTCTX request builder.
     * @param options
     *      userId:  user ID aditional entropy. By default 0000000000000001
     *      methods: flags for methods to include in context. USERAUTH_FLAG_HOTP, USERAUTH_FLAG_PASSWD.
     *      hotp: {digits}: hotp digits in the template. HOTP code length.
     *      passwd: {hash}: password hash used for authentication.
     * @returns {*}
     */
    build: function(options){
        this.configure(options);

        var ba = sjcl.bitArray;
        var hex = sjcl.codec.hex;

        // Part 1 - auth context, encrypt with random password, template.
        var tpl = eb.comm.hotp.getCtxTemplate(this.defaults);
        var userAuthCtxPrepared = eb.comm.hotp.prepareUserContext(tpl);

        // Part 2 - auth context, unprotected
        var userAuthCtxUserID = ""; // extract from template
        var userAuthCtxUserIDBits = hex.toBits(userAuthCtxUserID);
        var userAuthCtxBits = ba.concat(userAuthCtxUserIDBits, tpl);

        var request = [ba.partial(8, eb.comm.hotp.TLV_TYPE_USERAUTHCONTEXT)];
        request = ba.concat(request, [ba.partial(16, ba.bitLength(userAuthCtxPrepared)/8)]);
        request = ba.concat(request, userAuthCtxPrepared);

        request = ba.concat(request, [ba.partial(8, eb.comm.hotp.TLV_TYPE_NEWAUTHCONTEXT)]);
        request = ba.concat(request, [ba.partial(16, ba.bitLength(userAuthCtxBits)/8)]);
        request = ba.concat(request, userAuthCtxBits);

        return request;
    }
});

/**
 * HOTP user auth request builder.
 */
eb.comm.hotp.hotpUserAuthRequestBuilder.inheritsFrom(eb.comm.base, {
    /**
     * Auth request builder.
     * @param options
     *      authCode: hex coded auth code. In case of HOTP, it should be the output of hotpCodeToHexCoded()
     *      userId: hex coded user ID, 8B.
     *      userCtx: user context, bitArray.
     *      authOperation: auth operation to perform, default=TLV_TYPE_HOTPCODE
     * @returns {*}
     */
    build: function(options){
        // ref: performTestUserAuthVerification
        var ba = sjcl.bitArray;
        var hex = sjcl.codec.hex;

        // Options.
        var defaults = {
            authCode: undefined,
            userId: undefined,
            userCtx: undefined,
            authOperation: eb.comm.hotp.TLV_TYPE_HOTPCODE
        };
        options = ebextend(defaults, options || {});
        var userId = options && options.userId;
        var authCode = options && options.authCode;
        var userCtx = options && options.userCtx;
        var authOperation = options && options.authOperation;
        if (!userId || !authCode || !userCtx || !authOperation){
            throw new eb.exception.invalid("User ID / HOTP / userCtx / authOperation code undefined");
        }

        var tlvOp, methods;
        if (authOperation == eb.comm.hotp.TLV_TYPE_HOTPCODE){
            tlvOp = eb.comm.hotp.TLV_TYPE_HOTPCODE;
            methods = eb.comm.hotp.USERAUTH_FLAG_HOTP;
        } else if (authOperation == eb.comm.hotp.TLV_TYPE_PASSWORDHASH){
            tlvOp = eb.comm.hotp.TLV_TYPE_PASSWORDHASH;
            methods = eb.comm.hotp.USERAUTH_FLAG_PASSWD;
        } else {
            throw new eb.exception.invalid("Unrecognized authentication method");
        }

        var verificationCode = eb.comm.hotp.userIdToHex(userId) + eb.misc.inputToHex(authCode);
        var verificationCodeBits = hex.toBits(verificationCode);
        var userCtxBits = eb.misc.inputToBits(userCtx);

        var request = [ba.partial(8, eb.comm.hotp.TLV_TYPE_USERAUTHCONTEXT)];
        request = ba.concat(request, [ba.partial(16, ba.bitLength(userCtxBits)/8)]);
        request = ba.concat(request, userCtxBits);

        request = ba.concat(request, [ba.partial(8, tlvOp)]);
        request = ba.concat(request, [ba.partial(16, ba.bitLength(verificationCodeBits)/8)]);
        request = ba.concat(request, verificationCodeBits);

        return request;
    }
});

/**
 * Generator of update auth context request
 */
eb.comm.hotp.updateAuthContextRequestBuilder.inheritsFrom(eb.comm.base, {
    defaults: {
        userId: undefined,
        userCtx: undefined,
        targetMethod: undefined,
        passwd: undefined
    },

    /**
     * Configures local object with the preferences.
     * @param options
     *      userId:  user ID aditional entropy. By default 0000000000000001
     *      userCtx: user context to update.
     *      targetMethod: method to update
     *      passwd: a new password hash to set in case of targetMethod == USERAUTH_FLAG_PASSWD
     */
    configure: function(options){
        if (options) {
            this.defaults = ebextend(true, this.defaults, options || {});
        }
    },

    build: function(options){
        // ref: performUpdateAuthCtx
        var ba = sjcl.bitArray;
        var hex = sjcl.codec.hex;
        this.configure(options);

        var userId = this.defaults.userId;
        var userCtx = this.defaults.userCtx;
        var passwd = this.defaults.passwd;
        var targetMethod = this.defaults.targetMethod;
        if (!userId || !userCtx || !targetMethod){
            throw new eb.exception.invalid("User ID / userCtx / targetMethod undefined");
        }
        if (targetMethod == eb.comm.hotp.USERAUTH_FLAG_PASSWD && passwd === undefined){
            throw new eb.exception.invalid("Password update method but password hash is undefined");
        }

        // Build update context request
        var userCtxBits = eb.misc.inputToBits(userCtx);
        var updateCtx = [];

        // User ID
        updateCtx = ba.concat(updateCtx, eb.comm.hotp.userIdToBits(userId));

        // Method #1 - HOTP
        if (targetMethod == eb.comm.hotp.USERAUTH_FLAG_HOTP){
            updateCtx = ba.concat(updateCtx, hex.toBits(sprintf("%02x0000", eb.comm.hotp.USER_AUTH_TYPE_HOTP)));
        }

        // Method #2 - Password
        if (targetMethod == eb.comm.hotp.USERAUTH_FLAG_PASSWD){
            var passwordBits = eb.misc.inputToBits(passwd);
            updateCtx = ba.concat(updateCtx, hex.toBits(sprintf("%02x%04x", eb.comm.hotp.USER_AUTH_TYPE_PASSWD, ba.bitLength(passwordBits)/8)));
            updateCtx = ba.concat(updateCtx, passwordBits);
        }

        // Method #3 - Global attempts
        if (targetMethod == eb.comm.hotp.USERAUTH_FLAG_GLOBALTRIES){
            updateCtx = ba.concat(updateCtx, hex.toBits(sprintf("%02x0000", eb.comm.hotp.USER_AUTH_TYPE_GLOBALTRIES)));
        }

        // Request itself.
        var request = [];
        request = ba.concat(request, [ba.partial(8,  eb.comm.hotp.TLV_TYPE_USERAUTHCONTEXT)]);
        request = ba.concat(request, [ba.partial(16, ba.bitLength(userCtxBits)/8)]);
        request = ba.concat(request, userCtxBits);

        request = ba.concat(request, [ba.partial(8,  eb.comm.hotp.TLV_TYPE_UPDATEAUTHCONTEXT)]);
        request = ba.concat(request, [ba.partial(16, ba.bitLength(updateCtx)/8)]);
        request = ba.concat(request, updateCtx);

        return request;
    }
});

/**
 * General HOTP response parser, base class.
 */
eb.comm.hotp.generalHotpParser.inheritsFrom(eb.comm.base, {
    response: undefined,

    /**
     * General parsing routine for HOTP responses.
     *
     * @param data
     * @param resp response to fill in with parsed data, takes preference to options.response
     * @param options
     *      tlvOp: HOTP operation to expect
     *      methods: auth methods to parse from the response (default=0)
     *      bIsLocalCtxUpdate: if set to YES, hotp key is updated in ctx (default=YES)
     *      userId: user ID to match against response user ID (default=undefined, no matching)
     *      response: response to fill in with parsed data. (default=undefined, new one is created)
     *
     * @returns {*|eb.comm.response|null|request|number|Object}
     */
    parse: function(data, resp, options){
        // ref: processUserAuthResponse
        var ba = sjcl.bitArray;
        var offset = 0;

        // Options.
        var defaults = {
            tlvOp: undefined,
            methods: 0x0,
            bIsLocalCtxUpdate: true,
            userId: undefined,
            response: undefined
        };

        options = ebextend(defaults, options || {});
        var tlvOp = options && options.tlvOp;
        var methods = options && options.methods;
        var bIsLocalCtxUpdate = options && options.bIsLocalCtxUpdate;
        var givenUserId = options && options.userId;
        var response = resp || (options && options.response);
        response = response || new eb.comm.hotp.hotpResponse();
        if (tlvOp === undefined){
            throw new eb.exception.corrupt("Main TLV operation undefined");
        }

        this.response = response;
        response.hotpStatus = 0x0;
        response.hotpParsingSuccessful = false;
        response.hotpShouldUpdateCtx = false;

        // Check for the plainData length = 0 was here, but protected data does not contain plain data,
        // it was moved to a different field in the response message so we don't check it here,
        // while original code in processUserAuthResponse does.

        // Check main tag value.
        var tag = ba.extract(data, offset, 8);
        offset += 8;
        if (tag != eb.comm.hotp.TLV_TYPE_USERAUTHCONTEXT){
            response.hotpStatus = eb.comm.status.SW_INVALID_TLV_FORMAT;
            throw new eb.exception.corrupt("Unrecognized TLV tag");
        }

        // Extract user context.
        var userCtxLen = ba.extract(data, offset, 16);
        offset += 16;
        response.hotpUserCtx = ba.bitSlice(data, offset, offset+userCtxLen*8);
        offset += userCtxLen*8;

        // Main TLV op type
        var msgTlv = ba.extract(data, offset, 8);
        offset += 8;
        if (msgTlv != tlvOp){
            response.hotpStatus = eb.comm.status.SW_INVALID_TLV_FORMAT;
            throw new eb.exception.corrupt("Main TLV tag does not match");
        }

        // Response
        var responseLen = ba.extract(data, offset, 16);
        offset += 16;

        // User ID
        var requestUserId = ba.bitSlice(data, offset, offset+eb.comm.hotp.USERAUTHCTX_MAIN_USERID_LENGTH*8);
        offset += eb.comm.hotp.USERAUTHCTX_MAIN_USERID_LENGTH*8;

        // Compare set user id.
        if (givenUserId){
            if (!ba.equal(eb.comm.hotp.userIdToBits(givenUserId), requestUserId)){
                response.hotpStatus = eb.comm.status.SW_AUTH_MISMATCH_USER_ID;
                throw new eb.exception.corrupt("User ID mismatch");
            }
        }
        response.hotpUserId = requestUserId;

        // Methods
        var methodTag, dataReturnLen;

        // Method #1
        if ((methods & eb.comm.hotp.USERAUTH_FLAG_HOTP) > 0){
            methodTag = ba.extract(data, offset, 8);
            offset += 8;
            if (methodTag != eb.comm.hotp.USER_AUTH_TYPE_HOTP){
                response.hotpStatus = eb.comm.status.SW_AUTHMETHOD_UNKNOWN;
                throw new eb.exception.corrupt("Invalid method tag");
            }

            dataReturnLen = ba.extract(data, offset, 16);
            offset += 16;
            if (bIsLocalCtxUpdate){
                response.hotpKey = ba.bitSlice(data, offset, offset+dataReturnLen*8);

            } else if (dataReturnLen !== 0) {
                throw new eb.exception.corrupt("Should not contain data");
            }

            offset += dataReturnLen*8;
        }

        // Method #2
        if ((methods & eb.comm.hotp.USERAUTH_FLAG_PASSWD) > 0){
            methodTag = ba.extract(data, offset, 8);
            offset += 8;
            if (methodTag != eb.comm.hotp.USER_AUTH_TYPE_PASSWD){
                response.hotpStatus = eb.comm.status.SW_AUTHMETHOD_UNKNOWN;
                throw new eb.exception.corrupt("Invalid method tag");
            }

            dataReturnLen = ba.extract(data, offset, 16);
            offset += 16;
            if (dataReturnLen !== 0) {
                throw new eb.exception.corrupt("Should not contain data");
            }
        }

        // Method #3
        if ((methods & eb.comm.hotp.USERAUTH_FLAG_GLOBALTRIES) > 0){
            methodTag = ba.extract(data, offset, 8);
            offset += 8;
            if (methodTag != eb.comm.hotp.USER_AUTH_TYPE_GLOBALTRIES){
                response.hotpStatus = eb.comm.status.SW_AUTHMETHOD_UNKNOWN;
                throw new eb.exception.corrupt("Invalid method tag");
            }

            dataReturnLen = ba.extract(data, offset, 16);
            offset += 16;
            if (dataReturnLen !== 0) {
                throw new eb.exception.corrupt("Should not contain data");
            }
        }

        if ((offset + 16) != ba.bitLength(data)){
            throw new eb.exception.corrupt("Data length invalid");
        }

        response.hotpStatus = ba.extract(data, offset, 16);
        offset += 16;

        response.hotpShouldUpdateCtx = true;
        response.hotpParsingSuccessful = true;
        return response;
    }
});

/**
 * new HOTP user response parser.
 */
eb.comm.hotp.newHotpUserResponseParser.inheritsFrom(eb.comm.hotp.generalHotpParser, {
    parse: function(data, resp, options){
        options = options || {};
        options.tlvOp = eb.comm.hotp.TLV_TYPE_NEWAUTHCONTEXT;
        options.bIsLocalCtxUpdate = true;
        options.userId = undefined;
        options.methods = options.methods || eb.comm.hotp.USERAUTH_FLAG_HOTP;

        return eb.comm.hotp.newHotpUserResponseParser.superclass.parse.call(this, data, resp, options);
    }
});

/**
 * HOTP user auth response parser.
 */
eb.comm.hotp.hotpUserAuthResponseParser.inheritsFrom(eb.comm.hotp.generalHotpParser, {
    parse: function(data, resp, options){
        options = options || {};
        options.bIsLocalCtxUpdate = false;
        options.tlvOp = options.tlvOp || eb.comm.hotp.TLV_TYPE_HOTPCODE;
        options.methods = options.methods || eb.comm.hotp.USERAUTH_FLAG_HOTP;

        return eb.comm.hotp.hotpUserAuthResponseParser.superclass.parse.call(this, data, resp, options);
    }
});

/**
 * HOTP user auth response parser.
 */
eb.comm.hotp.updateAuthContextResponseParser.inheritsFrom(eb.comm.hotp.generalHotpParser, {
    parse: function(data, resp, options){
        options = options || {};
        options.bIsLocalCtxUpdate = true;
        options.tlvOp = eb.comm.hotp.TLV_TYPE_UPDATEAUTHCONTEXT;

        return eb.comm.hotp.updateAuthContextResponseParser.superclass.parse.call(this, data, resp, options);
    }
});

/**
 * HOTP request, base class.
 */
eb.comm.hotp.hotpRequest.inheritsFrom(eb.comm.processData, {
    /**
     * UserObject to use for the call.
     * TODO: once ready, move to processData request as comm keys will be stored there.
     */
    uo: undefined,

    /**
     * User ID to use.
     */
    userId: undefined,

    // Done & fail callback hooking.
    doneCallbackOrig: function(response, requestObj, data){},
    failCallbackOrig: function(failType, data){},

    done: function(x){
        this.doneCallbackOrig = x;
        eb.comm.hotp.hotpRequest.superclass.done.call(this, this.subDone);
        return this;
    },

    fail: function(x){
        this.failCallbackOrig = x;
        eb.comm.hotp.hotpRequest.superclass.fail.call(this, this.subFail);
        return this;
    },

    /**
     * Process configuration from the config object.
     * @param configObject object with the configuration.
     */
    configure: function(configObject){
        if (!configObject){
            this._log("Invalid config object");
            return;
        }

        // Configure with parent.
        eb.comm.hotp.hotpRequest.superclass.configure.call(this, configObject);

        // Configure this.
        if ('hotp' in configObject){
            this.configureHotp(configObject.hotp);
        }
    },

    /**
     * Configuration helper for HOTP data.
     * Called from configure() and build().
     * @param hotpData
     */
    configureHotp: function(hotpData){
        var ak = eb.misc.absorbKey;
        ak(this, hotpData, "uo");
        ak(this, hotpData, "userId");
    },

    /**
     * Response object is HOTP response.
     * After data unwrap, it will be processed further.
     *
     * @returns {eb.comm.hotp.hotpResponse}
     */
    getResponseObject: function(){
        return new eb.comm.hotp.hotpResponse();
    },

    /**
     * Called when underlying parser finished processing. Post processing here.
     *
     * @param response
     * @param requestObj
     * @param data
     * @private
     */
    subDone: function(response, requestObj, data){
        if (this.doneCallbackOrig){
            this.doneCallbackOrig(response, requestObj, data);
        }
    },

    /**
     * Called when underlying api request failed. Post processing here.
     * @param failType
     * @param data
     */
    subFail: function(failType, data){
        if (this.failCallbackOrig){
            this.failCallbackOrig(failType, data);
        }
    }
});

/**
 * New HOTP user request.
 * TODO: For configuration, new configuration builder can be implemented.
 */
eb.comm.hotp.newHotpUserRequest.inheritsFrom(eb.comm.hotp.hotpRequest, {
    /**
     * Configuration object given in construction / configure / build phases
     */
    authConfig: ebextend(true, {}, eb.comm.hotp.newHotpUserRequestBuilder.defaults),

    /**
     * Process HOTP configuration.
     * @param hotpObject hotp object
     */
    configureHotp: function(hotpObject){
        // Configure with parent.
        eb.comm.hotp.newHotpUserRequest.superclass.configureHotp.call(this, hotpObject);

        // authConfig
        this.authConfig = ebextend(true, this.authConfig, hotpObject || {});
    },

    /**
     * Initializes state and builds request
     */
    build: function(configObject){
        this._log("Building request body");
        if (configObject && 'hotp' in configObject){
            this.configureHotp(configObject.hotp);
        }

        // Build the new HOTPCTX() request.
        var builder = new eb.comm.hotp.newHotpUserRequestBuilder(this.authConfig);
        var upperRequest = builder.build();

        //var upperRequest = eb.comm.hotp.getNewUserRequest(this.userId, this.hotpLength);
        this._log("New HOTPCTX request: " + sjcl.codec.hex.fromBits(upperRequest));

        // Request data to lower process data builder.
        eb.comm.hotp.newHotpUserRequest.superclass.build.call(this, [], upperRequest);
    },

    /**
     * Process result, unwrapped by the underlying response parser.
     * @param response
     * @param requestObj
     * @param data
     */
    subDone: function(response, requestObj, data){
        var parser = new eb.comm.hotp.newHotpUserResponseParser(this.authConfig);
        var options = {};
        if (this.authConfig && this.authConfig.methods){
            options.methods = this.authConfig.methods;
        }

        try {
            this.response = response = parser.parse(response.protectedData, response, options);
            if (response.hotpStatus == eb.comm.status.SW_STAT_OK) {
                if (this.doneCallbackOrig) {
                    this.doneCallbackOrig(response, requestObj, data);
                }
                return;
            }
        } catch(e){
            data.hotpException = e;
        }

        if (this.failCallbackOrig){
            this.failCallbackOrig(eb.comm.status.PDATA_FAIL_RESPONSE_FAILED, data);
        }
    }
});

/**
 * HOTP user auth request.
 */
eb.comm.hotp.authHotpUserRequest.inheritsFrom(eb.comm.hotp.hotpRequest, {
    userCtx: undefined,
    hotpCode: undefined,
    hotpLength: eb.comm.hotp.HOTP_DIGITS_DEFAULT,
    passwd: undefined,

    // Private variables, request configures response parser.
    authMethod: undefined,
    authFlag: undefined,

    /**
     * Process HOTP configuration.
     * @param hotpObject hotp object
     */
    configureHotp: function(hotpObject){
        // Configure with parent.
        eb.comm.hotp.authHotpUserRequest.superclass.configureHotp.call(this, hotpObject);

        // Configure this.
        var ak = eb.misc.absorbKey;
        ak(this, hotpObject, "userCtx");
        ak(this, hotpObject, "hotpCode");
        ak(this, hotpObject, "hotpLength");
        ak(this, hotpObject, "passwd");
    },

    /**
     * Initializes state and builds request
     */
    build: function(configObject){
        this._log("Building request body");
        if (configObject && 'hotp' in configObject){
            this.configureHotp(configObject.hotp);
        }

        // Current limitation - only one method at a time
        if (this.passwd && this.passwd.length > 0 && this.hotpCode){
            this._log("Multiple authentication methods were required.");
            throw new eb.exception.invalid("Authentication supports only one authentication method at a time");
        }

        var authCode;
        if (this.passwd && this.passwd.length > 0){
            authCode = this.passwd;
            this.authMethod = eb.comm.hotp.TLV_TYPE_PASSWORDHASH;
            this.authFlag = eb.comm.hotp.USERAUTH_FLAG_PASSWD;
            this._log("Using Password authentication");

        } else if (this.hotpCode) {
            authCode = eb.comm.hotp.hotpCodeToHexCoded(this.hotpCode, this.hotpLength);
            this.authMethod = eb.comm.hotp.TLV_TYPE_HOTPCODE;
            this.authFlag = eb.comm.hotp.USERAUTH_FLAG_HOTP;
            this._log("Using HOTP authentication");

        } else {
            throw new eb.exception.invalid("No authentication data given");
        }

        // Build the auth request.
        var upperRequest = eb.comm.hotp.getUserAuthRequest(
            this.userId,
            authCode,
            this.userCtx,
            this.authMethod);

        this._log("HOTP Auth request: " + sjcl.codec.hex.fromBits(upperRequest));

        // Request data to lower process data builder.
        eb.comm.hotp.authHotpUserRequest.superclass.build.call(this, [], upperRequest);
    },

    /**
     * Process result, unwrapped by the underlying response parser.
     * @param response
     * @param requestObj
     * @param data
     */
    subDone: function(response, requestObj, data){
        var parser = new eb.comm.hotp.hotpUserAuthResponseParser();
        var options = {
            userId: this.userId,
            tlvOp:  this.authMethod,
            methods:this.authFlag
        };

        try {
            this.response = response = parser.parse(response.protectedData, response, options);
            if (response.hotpStatus == eb.comm.status.SW_STAT_OK) {
                if (this.doneCallbackOrig) {
                    this.doneCallbackOrig(response, requestObj, data);
                }
                return;
            }

        } catch(e){
            data.hotpException = e;
        }

        if (this.failCallbackOrig){
            data.response = this.response;
            this.failCallbackOrig(eb.comm.status.PDATA_FAIL_RESPONSE_FAILED, data);
        }
    }
});

/**
 * Request to update auth context.
 */
eb.comm.hotp.authContextUpdateRequest.inheritsFrom(eb.comm.hotp.hotpRequest, {
    userCtx: undefined,
    passwd: undefined,
    method: undefined,

    /**
     * Process HOTP configuration.
     * @param hotpObject hotp object
     */
    configureHotp: function(hotpObject){
        // Configure with parent.
        eb.comm.hotp.authContextUpdateRequest.superclass.configureHotp.call(this, hotpObject);

        // Configure this.
        var ak = eb.misc.absorbKey;
        ak(this, hotpObject, "userCtx");
        ak(this, hotpObject, "method");
        ak(this, hotpObject, "passwd");
    },

    /**
     * Initializes state and builds request
     */
    build: function(configObject){
        this._log("Building request body");
        if (configObject && 'hotp' in configObject){
            this.configureHotp(configObject.hotp);
        }

        if (this.method === undefined){
            throw new eb.exception.invalid("Update method not defined");
        }
        if (this.userId === undefined || this.userCtx === undefined){
            throw new eb.exception.invalid("UserID / UserCtx not defined");
        }
        if (this.method === eb.comm.hotp.USERAUTH_FLAG_PASSWD && this.passwd === undefined){
            throw new eb.exception.invalid("Update method is password but password is undefined");
        }

        // Build the auth request.
        var reqBuilder = new eb.comm.hotp.updateAuthContextRequestBuilder({
            userId: this.userId,
            userCtx: this.userCtx,
            targetMethod: this.method,
            passwd: this.passwd
        });

        var upperRequest = reqBuilder.build();

        this._log("Auth context update request: " + sjcl.codec.hex.fromBits(upperRequest));

        // Request data to lower process data builder.
        eb.comm.hotp.authContextUpdateRequest.superclass.build.call(this, [], upperRequest);
    },

    /**
     * Process result, unwrapped by the underlying response parser.
     * @param response
     * @param requestObj
     * @param data
     */
    subDone: function(response, requestObj, data){
        var parser = new eb.comm.hotp.updateAuthContextResponseParser();
        var options = {
            userId: this.userId,
            methods:this.method
        };

        try {
            this.response = response = parser.parse(response.protectedData, response, options);
            if (response.hotpStatus == eb.comm.status.SW_STAT_OK) {
                if (this.doneCallbackOrig) {
                    this.doneCallbackOrig(response, requestObj, data);
                }
                return;
            }

        } catch(e){
            data.hotpException = e;
        }

        if (this.failCallbackOrig){
            data.response = this.response;
            this.failCallbackOrig(eb.comm.status.PDATA_FAIL_RESPONSE_FAILED, data);
        }
    }
});

/**
 * Create user object name space.
 * @type {{}}
 */
eb.comm.createUO = {};

eb.comm.createUO.utils = {
    /**
     * @typedef {Object} RSAPubKey
     * @property {Array} n Public Modulus
     * @property {Array} e Public Exponent
     */

    /**
     * Reads TLV serialized RSA public key
     * @param pubKey
     * @returns {RSAPubKey}
     */
    readSerializedPubKey: function(pubKey){
        // TAG|len-2B|value. 81 = exponent, 82 = modulus
        var w = sjcl.bitArray;
        var ba = eb.misc.inputToBits(pubKey);
        var result = {n: undefined, e:undefined};

        var tag, len, pos = 0, dat, ln = w.bitLength(ba)/8;
        for(;pos < ln;){
            tag = w.extract(ba, 8*pos, 8); pos+=1;
            len = w.extract(ba, 8*pos, 16); pos+=2;
            dat = w.bitSlice(ba, 8*pos, 8*(pos+len)); pos+=len;
            switch(tag){
                case 0x81:
                    result.e = dat;
                    break;
                case 0x82:
                    result.n = dat;
                    break;
                default:
                    break;
            }
        }

        if (result.n === undefined || result.e === undefined){
            throw new eb.exception.invalid("Could not deserialize TLV serialized public key");
        }

        return result;
    }

};

eb.comm.createUO.consts = {
    YES: "yes",
    NO: "no",

    uoType:{
        HMAC: 0x0001,
        SCRAMBLE: 0x0002,
        ENSCRAMBLE: 0x0003,
        PLAINAES: 0x0004,
        RSA1024DECRYPT_NOPAD: 0x0005,
        RSA2048DECRYPT_NOPAD: 0x0006,
        EC_FP192SIGN: 0x0007,
        AUTH_HOTP: 0x0008,
        AUTH_NEW_USER_CTX: 0x0009,
        AUTH_PASSWORD: 0x000a,
        AUTH_UPDATE_USER_CTX: 0x000b,
        TOKENIZE: 0x000c,
        DETOKENIZE: 0x000d,
        TOKENIZEWRAP: 0x000e,
        PLAINAESDECRYPT: 0x000f,
        RANDOMDATA: 0x0010,
        CREATENEWUO: 0x0011,
        RSA1024ENCRYPT_NOPAD: 0x0012,
        RSA2048ENCRYPT_NOPAD: 0x0013
    },

    environment:{
        DEV: "dev",
        TEST: "test",
        PROD: "prod"
    },

    maxtps: {
        _1: "one",
        _10: "ten",
        _20: "twenty",
        _50: "fifty",
        _100: "one_hundred",
        _200: "two_hundred",
        _500: "five_hundred",
        _1000: "one_thousand",
        _2000: "two_thousand",
        _5000: "five_thousand",
        _10000: "ten_thousand",
        _50000: "fifty_thousand",
        _100000: "hundred_thousand",
        UNLIMITED: "unlimited"
    },

    core: {
        EMPTY: "empty",
        _1: "one",
        _2: "two",
        _3: "three",
        _5: "five",
        _10: "ten",
        _20: "twenty",
        CLUSTER: "cluster"
    },

    persistence: {
        _1min: "one_minute",
        _2min: "two_minutes",
        _5min: "five_minutes",
        _15min: "fifteen_minutes",
        _30min: "thirty_minutes",
        _1h: "one_hour",
        _2h: "two_hours",
        _6h: "six_hours",
        _12h: "twelve_hours",
        _1d: "one_day",
        _2d: "two_days",
        _7d: "seven_days",
        _14d: "forteen_days",
        _28d: "twentyeight_days",
        _1mon: "one_month"
    },

    priority: {
        LOW: "low",
        DEFAULT: "default",
        HIGH: "high",
        MAX: "maximum"
    },

    separation: {
        TIME: "time",
        COMPLETE: "complete"
    },

    resource: {
        GLOBAL: "global",
        INSTANCE: "instance",
        CLUSTER: "cluster",
        CARD: "card"
    },

    genKey: {
        LEGACY_RANDOM: 0,
        CLIENT: 1,
        COMP1: 2,
        COMP2: 3,
        COMP3: 4,
        SERVER_RANDOM: 5,
        SERVER_DERIVED: 6
    }
};

/**
 * getUOTemplate response.
 * @extends eb.comm.response
 */
eb.comm.createUO.UOTemplateResponse = function(x){
    eb.misc.absorb(this, x);
};
eb.comm.createUO.UOTemplateResponse.inheritsFrom(eb.comm.response, {
    /**
     * Response fields
     */
    uot: {
        "objectid": undefined,
        "version": undefined, //<integer>,
        "protocol": undefined, //<integer>,
        "encryptionoffset": undefined, //<decimal_number>,
        "flagoffset": undefined, //<decimal_number>,
        "policyoffset": undefined, //<decimal_number>,
        "scriptoffset": undefined, //<decimal_number,
        "keyoffsets": [
            //{"type": "commk",  offset: 180, length: 20,  "tlvtype":1},
            //{"type": "comenc",  offset: 200, length: 10,  "tlvtype":1},
            //{"type": "commac",  offset: 210, length: 10,  "tlvtype":2},
            //{"type": "billing", offset: 220, length: 10,  "tlvtype":3},
            //{"type": "comnextenc", offset: 230, length: 10,  "tlvtype":4},
            //{"type": "conextmac", offset: 240, length: 10,  "tlvtype":5},
            //{"type": "app",    offset: 250, length: 200, "tlvtype":6}
        ],
        "template": undefined, // hexcoded
        "templatehs": undefined, // hexcoded
        "importkeys": [
            //{"id": <string>, "type":<"rsa2048"|"rsa1024">, "publickey": <string-serialized public key> },
        ],
        "authorization": undefined //<string>
    }
});

/**
 * Create new UO requests
 */
eb.comm.createUO.getUOTemplateRequest = function(){
    this.callFunction = "GetUserObjectTemplate";
};
eb.comm.createUO.getUOTemplateRequest.inheritsFrom(eb.comm.apiRequest, {
    objName: "getUOTemplateRequest",

    /**
     * Default request values.
     * @const
     */
    defaults: {
        "format": 1,        //<integer, starting with 1>,
        "protocol": 1,      //<integer, starting with 1>,
        "type": eb.comm.createUO.consts.uoType.PLAINAES,        //<32bit integer>,
        "environment": eb.comm.createUO.consts.environment.DEV, // shows whether the UO should be for production (live), test (pre-production testing), or dev (development)
        "maxtps": eb.comm.createUO.consts.maxtps._1, // maximum guaranteed TPS
        "core": eb.comm.createUO.consts.core.EMPTY, // how many cards have UO loaded permanently
        "persistence": eb.comm.createUO.consts.persistence._1min, // once loaded onto card, how long will the UO stay there without use (this excludes the "core")
        "priority": eb.comm.createUO.consts.priority.DEFAULT, // this defines a) priority when the server capacity is fully utilised and it also defines how quickly new copies of UO are installed (pre-empting icreasing demand)
        "separation": eb.comm.createUO.consts.separation.TIME, // "complete" = only one UO can be loaded on a smartcard at one one time
        "bcr": eb.comm.createUO.consts.YES,      // "yes" will ensure the UO is replicated to provide high availability for any possible service disruption
        "unlimited": eb.comm.createUO.consts.YES,
        "clientiv": eb.comm.createUO.consts.YES, //  if "yes", we expect the data starts with an IV to initialize decryption of data - this is for communication security
        "clientdiv": eb.comm.createUO.consts.NO, // if "yes", we expect the data starting with a diversification 16B for communication keys
        "resource": eb.comm.createUO.consts.resource.GLOBAL,
        "credit": 256, // <1-32767>, a limit a seed card can provide to the EB service
        "generation": {
            "commkey": eb.comm.createUO.consts.genKey.SERVER_RANDOM,
            "billingkey": eb.comm.createUO.consts.genKey.SERVER_RANDOM,
            "appkey": eb.comm.createUO.consts.genKey.SERVER_RANDOM
        }
    },

    /**
     * Process configuration from the config object.
     * @param configObject java object with the configuration.
     */
    configure: function(configObject){
        if (!configObject){
            this._log("Invalid config object");
            return;
        }

        var toConfig = configObject;
        if ("userObjectId" in configObject){
            toConfig = ebextend(true, toConfig, {uoId : configObject.userObjectId});
        }

        // Configure with parent.
        eb.comm.createUO.getUOTemplateRequest.superclass.configure.call(this, toConfig);
    },

    /**
     * Initializes state and builds request
     * @param {object} request
     */
    build: function(request){
        this._log("Building request body");

        // Request header data.
        this.buildApiBlock();
        this.buildReqHeader();
        this.reqBody = {data:this.defaults};
        this.reqBody.data = ebextend(true, this.reqBody.data, request || {});
        this.reqBody.data.type = eb.misc.inputToHex(this.reqBody.data.type);

        var nonce = this.getNonce();
        var url = this.getApiUrl();
        this._log("Nonce generated: " + nonce);
        this._log("URL: " + url + ", method: " + this.requestMethod);
        this._log("SocketReq: " + JSON.stringify(this.getSocketRequest()));
        this._log("Data: " + JSON.stringify(this.reqBody));
    },

    /**
     * Returns response parser when is needed. May lazily initialize parser.
     * Override point.
     *
     * @returns {*}
     */
    getResponseParser: function(){
        // Generic parser with given parsing function.
        var parser = new eb.comm.responseParser();
        parser.parsingFunction(function(data, resp, parser){
            var response = new eb.comm.createUO.UOTemplateResponse(resp);
            if (!data.result ) {
                parser._log("Invalid response");
                throw new eb.exception.invalid("Invalid response");
            }

            response.uot = data.result;
            return response;
        });

        this.responseParser = parser;
        return this.responseParser;
    }
});

/**
 * Template filler
 *
 * @param {object} options
 * @param {object} options.template
 * @param {boolean} options.debuggingLog
 * @param {Function} options.logger
 */
eb.comm.createUO.templateFiller = function(options){
    options = options || {};
    this.template = options.template;
    this.debuggingLog = options.debuggingLog || false;
    this.logger = options.logger;
};
eb.comm.createUO.templateFiller.prototype = {
    /**
     * Builds template to import.
     * keys:
     *  commk: {key: bits}
     *  app: {key: bits}
     */
    build: function(options){
        options = options || {};
        var template = options.template || this.template;
        var keys = options.keys || {};

        // Vars.
        var h = sjcl.codec.hex, w = sjcl.bitArray, i, ln, cKeyOff, cKey, cKeyVal;
        var baPlain, baProtected;

        // Message shortcuts.
        var encOffset = template.encryptionoffset;
        var keysOffset = template.keyoffsets || [];
        var importKeys = template.importkeys || [];
        var appKeyProvided = false;

        // Raw template to fill-in.
        var ba = eb.misc.inputToBits(template.template);

        // Fill in template keys?
        for(i = 0, ln = keysOffset.length; i < ln; ++i){
            cKeyOff = keysOffset[i];
            if (!cKeyOff || !cKeyOff.type || !(cKeyOff.type in keys)){
                this._log("Key not found: " + cKeyOff.type);
                continue;
            }

            cKey = keys[cKeyOff.type];
            cKeyVal = eb.misc.inputToBits(cKey.key);
            if (w.bitLength(cKeyVal) != cKeyOff.length){
                this._log("Key bitLength does not match: " + w.bitLength(cKeyVal) + " vs " + cKeyOff.length + " for: " + cKeyOff.type);
                continue;
            }

            if (cKeyOff.type == "app"){
                appKeyProvided = true;
            }

            // before + key + after
            ba = eb.misc.replacePart(ba, cKeyOff.offset, cKeyOff.offset + cKeyOff.length, cKeyVal);
        }

        // Reset comm key flag - generated by client.
        // 0x8 position, in short. flagOffset points to MSB byte of the short.
        ba = eb.misc.transformPart(ba, template.flagoffset+8, template.flagoffset+16, function(x){
            var num = sjcl.bitArray.extract(x, 0, 8);
            num &= ~0x8;
            if (appKeyProvided){
                num &= ~0x10;
            }
            return [sjcl.bitArray.partial(8, num)];
        });

        // Encrypt template from encOffset.
        baPlain = w.bitSlice(ba, 0, encOffset);
        baProtected = w.bitSlice(ba, encOffset);

        var tek, tmk;
        tek = sjcl.random.randomWords(8);
        tmk = sjcl.random.randomWords(8);
        baProtected = eb.padding.pkcs7.pad(baProtected);
        this._log('Padded plain template: ' + h.fromBits(baProtected) + ", len=" + w.bitLength(baProtected));

        // Symmetric Encryption
        var aes = new sjcl.cipher.aes(tek);
        var hmac = new sjcl.misc.hmac_cbc(new sjcl.cipher.aes(tmk), 16, eb.padding.empty);
        var IV = [0, 0, 0, 0];
        baProtected = sjcl.mode.cbc.encrypt(aes, baProtected, IV, [], true);
        this._log('Encrypted template: ' + h.fromBits(baProtected) + ", len=" + w.bitLength(baProtected));

        // baPlain | baProtected | MAC(baPlain | baProtected)
        ba = w.concat(baPlain, baProtected);
        ba = eb.padding.pkcs7.pad(ba);
        ba = w.concat(ba, hmac.mac(ba));

        // RSA encryption: UOID-4B | TEK | TMK
        var iKey = this._getBestImportKey(importKeys);
        var baRsaEnc = [];
        baRsaEnc = w.concat(baRsaEnc, [parseInt(template.objectid, 16)]);
        baRsaEnc = w.concat(baRsaEnc, tek);
        baRsaEnc = w.concat(baRsaEnc, tmk);
        this._log('To wrap: ' + h.fromBits(baRsaEnc) + ", len=" + w.bitLength(baRsaEnc));
        var wrapped = this._rsaEncrypt(baRsaEnc, iKey);

        // Final template: 0xa1 | len-2B | RSA-ENC-BLOB | 0xa2 | len-2B | encrypted-maced-template
        var finalTpl = [w.partial(8, 0xa1)];
        finalTpl = w.concat(finalTpl, [w.partial(16, w.bitLength(wrapped)/8)]);
        finalTpl = w.concat(finalTpl, wrapped);

        finalTpl = w.concat(finalTpl, [w.partial(8, 0xa2)]);
        finalTpl = w.concat(finalTpl, [w.partial(16, w.bitLength(ba)/8)]);
        finalTpl = w.concat(finalTpl, ba);

        // Return encrypted template.
        return {uo:finalTpl, keyUsed:iKey};
    },

    _rsaEncrypt: function(input, key){
        var iKeyBl = key.type == 'rsa2048' ? 2048 : 1024;
        var data = eb.padding.pkcs15.pad(input, iKeyBl/8, 2);
        this._log('To wrap padded: ' + sjcl.codec.hex.fromBits(data) + ", len=" + sjcl.bitArray.bitLength(data));

        // Deserialize public key, convert to integers, result = (message ^ exponent) mod modulus
        var pubKey = this._readSerializedPubKey(key.key);

        var msg = new BigInteger(sjcl.codec.hex.fromBits(data), 16);
        var mod = new BigInteger(sjcl.codec.hex.fromBits(pubKey.n), 16);
        var exp = parseInt(sjcl.codec.hex.fromBits(pubKey.e), 16);
        var res = msg.modPowInt(exp, mod);
        return sjcl.codec.hex.toBits(eb.misc.padHexToEven(res.toString(16)));

        // SJCL BN is terribly slow!!!
        //var msg = sjcl.bn.fromBits(data);
        //var mod = sjcl.bn.fromBits(pubKey.n);
        //var exp = sjcl.bn.fromBits(pubKey.e);
        //
        // Encryption.
        //msg.powermod(exp, mod);
        //return msg.toBits();
    },

    /**
     * Reads TLV serialized RSA public key
     * @param pubKey
     * @returns {{n: Array, e: Array}}
     * @private
     */
    _readSerializedPubKey: function(pubKey){
        return eb.comm.createUO.utils.readSerializedPubKey(pubKey);
    },

    _getBestImportKey: function(importKeys){
        var i, ln, cKey;
        importKeys = importKeys || [];

        // Search RSA2048.
        var kRsa2048 = undefined;
        var kRsa1024 = undefined;
        for(i=0, ln=importKeys.length; i<ln; i++){
            cKey = importKeys[i];
            if (kRsa1024 === undefined && cKey.type == "rsa1024"){
                kRsa1024 = cKey;
            }
            if (kRsa2048 === undefined && cKey.type == "rsa2048"){
                kRsa2048 = cKey;
            }
        }

        return (kRsa2048 === undefined) ? kRsa1024 : kRsa2048;
    },

    _log:  function(x) {
        if (!this.debuggingLog){
            return;
        }

        if (this.logger){
            this.logger(x);
        } else if (console && console.log){
            console.log(x);
        }
    }
};

/**
 * getUOTemplate response.
 * @extends eb.comm.response
 */
eb.comm.createUO.importUOResponse = function(x){
    eb.misc.absorb(this, x);
};
eb.comm.createUO.importUOResponse.inheritsFrom(eb.comm.response, {
    /**
     * Response fields
     */
    uoi: {
        "uoid": undefined
    }
});

/**
 * Import UO request
 * @extends eb.comm.apiRequest
 */
eb.comm.createUO.importUORequest = function(){
    this.callFunction = "CreateUserObject";
};
eb.comm.createUO.importUORequest.inheritsFrom(eb.comm.apiRequest, {
    objName: "CreateUserObject",

    /**
     * Default request values.
     * @const
     */
    defaults: {
        "objectid": undefined,       // 0x10
        "object": undefined,       // '0011223344556677'
        "authorization": ""
    },

    /**
     * Process configuration from the config object.
     * @param configObject java object with the configuration.
     */
    configure: function(configObject){
        if (!configObject){
            this._log("Invalid config object");
            return;
        }

        var toConfig = configObject;
        if ("userObjectId" in configObject){
            toConfig = ebextend(true, toConfig, {uoId : configObject.userObjectId});
        }

        // Configure with parent.
        eb.comm.createUO.importUORequest.superclass.configure.call(this, toConfig);
    },

    /**
     * Initializes state and builds request
     * @param {object} request
     */
    build: function(request){
        this._log("Building request body");

        // Request header data.
        this.buildApiBlock();
        this.buildReqHeader();
        this.reqBody = {data:this.defaults};
        this.reqBody.data = ebextend(true, this.reqBody.data, request || {});

        var nonce = this.getNonce();
        var url = this.getApiUrl();
        this._log("Nonce generated: " + nonce);
        this._log("URL: " + url + ", method: " + this.requestMethod);
        this._log("SocketReq: " + JSON.stringify(this.getSocketRequest()));
        this._log("Data: " + JSON.stringify(this.reqBody));
    },

    /**
     * Returns response parser when is needed. May lazily initialize parser.
     * Override point.
     *
     * @returns {*}
     */
    getResponseParser: function(){
        // Generic parser with given parsing function.
        var parser = new eb.comm.responseParser();
        parser.parsingFunction(function(data, resp, parser){
            var response = new eb.comm.createUO.importUOResponse(resp);
            if (!data.result ) {
                parser._log("Invalid response");
                throw new eb.exception.invalid("Invalid response");
            }

            response.uoi = data.result;
            return response;
        });

        this.responseParser = parser;
        return this.responseParser;
    }
});

/**
 * Client part
 * Client namespace containing high level function calls.
 */
eb.client = {
    /**
     * Basic client configuration, contains endpoints, API Key and basic operational settings.
     *
     * @param {Object} [options]
     * @param {String} [options.endpointProcess] ProcessData() endpoint
     * @param {String} [options.endpointEnroll] CreateUO() endpoint
     * @param {String} [options.endpointRegister] CreateAPIKey endpoint
     * @param {String} [options.apiKey] API key to use
     * @param {String} [options.httpMethod] HTTP method to use
     * @param {Integer} [options.timeout] Request timeout in milliseconds
     * @param {Object} [options.retryHandler] Override retry handler
     * @param {Object} [options.createTpl] CreateUO default template
     * @param {Object} [options.retry]
     */
    Configuration: function(options){
        this.endpointProcess = 'https://site2.enigmabridge.com:11180';
        this.endpointEnroll = 'https://site2.enigmabridge.com:11182';
        this.endpointRegister = 'https://hut6.enigmabridge.com:8445';

        // Request configuration - retry + parameters
        this.apiKey = 'API_TEST';
        this.httpMethod = eb.comm.REQ_METHOD_POST;
        this.timeout = 90000;
        this.retryHandler = new RetryHandler(ebextend(true, {maxAttempts: 3}, options.retry || {}));
        this.createTpl = {};

        // Configuration method.
        this.configure = function(options){
            options = options || {};

            var ak = eb.misc.absorbKey;
            ak(this, options, "endpointProcess");
            ak(this, options, "endpointEnroll");
            ak(this, options, "endpointRegister");
            ak(this, options, "apiKey");
            ak(this, options, "httpMethod");
            ak(this, options, "timeout");
            ak(this, options, "retryHandler");
            ak(this, options, "createTpl");
            if (!("retryHandler" in options) && "retry" in options){
                this.retryHandler = new RetryHandler(ebextend(true, {maxAttempts: 3}, options.retry || {}));
            }
            return this;
        };

        this.configure(options);
    },

    /**
     * UserObject representation.
     * @param {Object} [options]
     * @param {String|Integer} [options.uoID]
     * @param {String|Integer} [options.uoType]
     * @param {String|Array} [options.encKey]
     * @param {String|Array} [options.macKey]
     * @param {String} [options.apiKey]
     * @param {String} [options.endpoint]
     * @param {eb.client.Configuration} [options.configuration]
     */
    UO: function(options){
        /**
         * User object ID.
         * @type {Integer}
         */
        this.uoId = undefined;

        /**
         * User object type
         * @type {Integer}
         */
        this.uoType = undefined;

        /**
         * Encryption communication key.
         * @type {String|Array}
         */
        this.encKey = undefined;

        /**
         * MAC communication key.
         */
        this.macKey = undefined;

        /**
         * API key
         * @type {String}
         */
        this.apiKey = undefined;

        /**
         * Endpoint
         * @type {String}
         */
        this.endpoint = undefined;

        /**
         * Configuration
         * @type {Object}
         */
        this.configuration = undefined;

        /**
         * Returns API key to use
         * @returns {String}
         */
        this.resolveApiKey = function(){
            if (eb.misc.isDefined(this, "apiKey") && this.apiKey){
                return this.apiKey;
            }

            if (eb.misc.isDefined(this, "configuration") && this.configuration.apiKey){
                return this.configuration.apiKey;
            }

            return undefined;
        };

        /**
         * Returns endpoint to use to operate on.
         * @returns {String}
         */
        this.resolveEndpoint = function() {
            if (eb.misc.isDefined(this, "endpoint") && this.endpoint){
                return this.endpoint;
            }

            if (eb.misc.isDefined(this, "configuration") && this.configuration.endpointProcess){
                return this.configuration.endpointProcess;
            }

            return undefined;
        };

        this.configure = function(options){
            options = options || {};

            var ak = eb.misc.absorbKey;
            ak(this, options, "uoId");
            ak(this, options, "uoType");
            ak(this, options, "encKey");
            ak(this, options, "macKey");
            ak(this, options, "apiKey");
            ak(this, options, "endpoint");
            ak(this, options, "configuration");
            return this;
        };

        // Configure this instance
        this.configure(options);
    },

    /**
     * RSA private key created by createUO.
     * Contains UO & modulus & exponent values
     * @param options
     * @constructor
     */
    RSAPrivateKey: function(options){
        this.uo = undefined;
        this.n = undefined;
        this.e = undefined;

        this.configure = function(options){
            options = options || {};

            var ak = eb.misc.absorbKey;
            ak(this, options, "uo");
            ak(this, options, "n");
            ak(this, options, "e");
        };

        // Configure this instance
        this.configure(options);
    },

    /**
     * Process data call.
     * @param {Object} [options]
     * @param {Array} [options.input] input data to process.
     * @param {Object} [options.retry] configuration or retry handler.
     * @param {Object} [options.retryHandler] override retry handler
     * @param {Function} [options.logger] logger to log to
     * @param {eb.client.Configuration} [options.config] EB configuration
     * @param {eb.client.UO} [options.uo] UserObject
     */
    processData: function(options){
        this.request = undefined;
        this.retryHandler = undefined;
        this.listeners = [];
        this.data = undefined;
        this.wasBuilt = false;
        this.logger = undefined;
        this.config = undefined;

        /**
         * Configures the process data call. Wipes the old state.
         * @param {Object} [options]
         * @param {Array} [options.input] input data to process.
         * @param {Object} [options.retry] configuration or retry handler.
         * @param {Object} [options.retryHandler] override retry handler
         * @param {Function} [options.logger] logger to log to
         * @param {eb.client.Configuration} [options.config] EB configuration
         * @param {eb.client.UO} [options.uo] UserObject
         * @returns {eb.client}
         */
        this.configure = function(options){
            options = options || {};
            this.config = options;

            // High-level configuration object
            if (eb.misc.isDefined(options, "config")){
                this.config.config = options.config;
            }

            // High level config - user object.
            if (eb.misc.isDefined(options, "uo")){
                this.config.uo = options.uo;

                // Configuration is missing but it may be stored in UO.
                if (!eb.misc.isDefined(this.config, "config") && eb.misc.isDefined(options.uo, "configuration")){
                    this.config.config = options.uo.configuration;
                }
            }

            // Logger
            this.logger = options.logger || function(){};

            // Configure retry handler.
            if (eb.misc.isDefined(options, "retryHandler")) {
                this.retryHandler = options.retryHandler;
            } else {
                this.retryHandler = new RetryHandler(ebextend(true, {maxAttempts: 3}, options.retry || {}));
            }

            // Configure request
            this.request = new eb.comm.processData();
            this.request.configure(this.prepareConfigRequest());

            // Data passed in?
            if ("input" in options){
                this.data = options.input;
            } else {
                this.data = undefined;
            }

            return this;
        };

        /**
         * Prepares a configuration for request object from the internal configuration.
         */
        this.prepareConfigRequest = function(fromConfig){
            var srcCfg = fromConfig === undefined ? this.config : fromConfig;
            var tmpCfg = ebextend(true, {}, srcCfg);
            var isDefined = eb.misc.isDefined;
            var ak = eb.misc.absorbKeyIfNotSet;

            // If UserObject is defined
            if (isDefined(srcCfg, "uo")){
                var uo = srcCfg.uo;

                ak(tmpCfg, 'uoId', uo, 'uoId');
                ak(tmpCfg, 'uoType', uo, 'uoType');
                ak(tmpCfg, 'encKey', uo, 'encKey');
                ak(tmpCfg, 'macKey', uo, 'macKey');
                ak(tmpCfg, 'apiKey', uo, 'apiKey');
                ak(tmpCfg, 'endpoint', uo, 'endpoint');
            }

            // If configuration is defined, we can take some settings from there.
            if (isDefined(srcCfg, "config")){
                var config = srcCfg.config;

                ak(tmpCfg, 'host', config, 'endpointProcess');
                ak(tmpCfg, 'endpoint', config, 'endpointProcess');
                ak(tmpCfg, 'apiKey', config, 'apiKey');
                ak(tmpCfg, 'requestTimeout', config, 'timeout');
                ak(tmpCfg, 'retryHandler', config, 'retryHandler');
            }

            return tmpCfg;
        };

        /**
         * Builds request body with the data passed.
         * @param {bitArray|String|Array} [data] Data to process
         * @returns {eb.client}
         */
        this.build = function(data){
            if (typeof data !== 'undefined' && typeof data.input !== 'undefined'){
                this.data = data.input;
            } else if (typeof data !== 'undefined'){
                this.data = data;
            }

            if (typeof this.data === 'undefined'){
                throw new eb.exception.invalid("Data to process undefined, cannot build");
            }

            this.request.build([], eb.misc.inputToBits(this.data));
            this.wasBuilt = true;
            return this;
        };

        /**
         * Calls the processData()
         * Returns promise on the result.
         *
         * @param [data] Data to process
         * @returns {Promise}
         */
        this.call = function(data){
            return new Promise((function(resolve, reject) {
                // Build if not built.
                if (!this.wasBuilt){
                    this.build(data);
                }

                // EB function to call, forward definition.
                var ebOpFnc = undefined;

                // Success handler - reset retry handler, call success CB.
                var onEbOpSuccess = (function(data){
                    this.retryHandler.reset();
                    resolve(data);
                }).bind(this);

                // Failure handler - try to retry if limit is not reached.
                var onEbOpFailure = (function(data){
                    if (this.retryHandler.limitReached()){
                        this.logger("EB failure - limit reached");
                        reject(ebextend(true, data, {retry:{'reason':'retry attempts limit reached'}}));
                        return;
                    }

                    var interval = this.retryHandler.retry(ebOpFnc.bind(this));
                    this.onRetry({'interval': interval, 'scheme':this});
                    this.logger(sprintf("EB failure[%s], next attempt: %s ms", this.retryHandler.numAttempts(), interval));
                }).bind(this);

                // Call EB operation.
                ebOpFnc = (function(){
                    this.ebOp_(onEbOpSuccess.bind(this), onEbOpFailure.bind(this));
                }).bind(this);

                // First call/kick off.
                this.retryHandler.reset();
                ebOpFnc();

            }).bind(this));
        };

        this.ebOp_ = function(onSuccess, onFailure){
            // On EB call fail.
            var onEBFail = (function(data){
                onFailure({data: data});
            }).bind(this);

            // On EB call success.
            var onEBSuccess = (function(response, data){
                var responseStatus = response.statusCode;
                if (responseStatus != eb.comm.status.SW_STAT_OK || response.protectedData === undefined) {
                    // Critical error?
                    onEBFail({response:response, data:data});
                    return;
                }

                onSuccess({data:response.protectedData});
            }).bind(this);

            // Request callbacks.
            this.request.done((function(response, requestObj, data) {
                (onEBSuccess.bind(this))(response, data);

            }).bind(this));

            this.request.fail((function(failType, data){
                if (failType == eb.comm.status.PDATA_FAIL_RESPONSE_FAILED){
                    (onEBSuccess.bind(this))(data.response, data); // application level failure.

                } else if (failType == eb.comm.status.PDATA_FAIL_CONNECTION){
                    (onEBFail.bind(this))(data);
                }

            }).bind(this));

            // Submit request.
            this.request.doRequest();
        };

        this.onRetry = function(data){
            this.triggerEvent("retry", data);
        };

        this.triggerEvent = function(evt, data){
            this.listeners[evt] = this.listeners[evt] || [];
            for(var i = 0, ln = this.listeners[evt].length; i < ln; i++){
                this.listeners[evt][i](data);
            }
        };

        this.listen = function(evt, listener){
            this.listeners[evt] = this.listeners[evt] || [];
            this.listeners[evt].push(listener);
            return this;
        };

        this.unlisten = function(evt, listener){
            this.listeners[evt] = this.listeners[evt] || [];

            for(var i = 0, ln = this.listeners[evt].length; i < ln; i++){
                if(this.listeners[evt][i] === listener) {
                    this.listeners[evt].splice(i,1);
                    return this;
                }
            }
            return this;
        };

        this.cancel = function(data){
            this.retryHandler.cancel();
            return this;
        };

        this.retry = function(data){
            // TODO: this
            return this;
        };

        // Configure this instance
        this.configure(options);
    },

    /**
     * Create UO call.
     *
     * @param {Object} [options]
     * @param {Integer} [options.objType] UserObject type to create (eb.comm.createUO.consts.uoType)
     * @param {eb.client.Configuration} [options.config] Configuration
     * @param {Array} [options.tpl] template for creating a new UO
     * @param {Array} [options.keys] UO keys
     * @param {Array} [options.retry] retry handler settings to use
     * @param {Array} [options.retryHandler] the whole retry handler
     * @param {boolean} [options.expert] expert flag indicating the setting should be taken as it is, e.g., no
     *                                   comm key generation is performed
     * @param {Function} [options.logger]
     * @param {Number} [options.bits] RSA private key bit size (for createRSA call).
     */
    createUO: function(options){
        this.tplRequest = undefined;
        this.impRequest = undefined;

        this.config = undefined;
        this.uoRequest = undefined;
        this.keys = undefined;

        this.retryHandler = undefined;
        this.listeners = [];
        this.logger = undefined;

        // Process results
        this.templateResponse = undefined;
        this.tplUsed = undefined;
        this.importResponse = undefined;
        this.uo = undefined;

        /**
         * Configures the call. Wipes the old state.
         * @param {Integer} [options.objType] UserObject type to create (eb.comm.createUO.consts.uoType)
         * @param {eb.client.Configuration} [options.config] Configuration
         * @param {Array} [options.tpl] template for creating a new UO
         * @param {Array} [options.keys] UO keys
         * @param {Array} [options.retry] retry handler settings to use
         * @param {Array} [options.retryHandler] the whole retry handler
         * @param {boolean} [options.expert] expert flag indicating the setting should be taken as it is, e.g., no
         *                                   comm key generation is performed
         * @param {Function} [options.logger]
         * @returns {eb.client}
         */
        this.configure = function(options){
            options = options || {};

            // Basic config pre-processing.
            // .. none
            this.config = options;

            // High-level configuration object
            if (eb.misc.isDefined(options, "config")){
                this.config.config = options.config;

                // Default TPL
                if (eb.misc.isDefined(options.config, "createTpl")) {
                    this.uoRequest = ebextend(true, this.uoRequest || {}, this.config.config.createTpl)
                }
            }

            if ("tpl" in options){
                this.uoRequest = ebextend(true, this.uoRequest || {}, options.tpl);
            }

            if ("keys" in options){
                this.keys = options.keys;
            } else {
                this.keys = {};
            }

            // Convenience settings
            this.expert = options.expert || false;
            if (!this.expert){
                if (!eb.misc.isDefined(this.keys, "comenc")){
                    this.keys.comenc = {key: sjcl.random.randomWords(8)};
                }
                if (!eb.misc.isDefined(this.keys, "commac")){
                    this.keys.commac = {key: sjcl.random.randomWords(8)};
                }
                if (!eb.misc.isDefined(this.keys, "comnextenc")){
                    this.keys.comnextenc = {key: sjcl.random.randomWords(8)};
                }
                if (!eb.misc.isDefined(this.keys, "conextmac")){
                    this.keys.conextmac = {key: sjcl.random.randomWords(8)};
                }
            }

            if (eb.misc.isDefined(options, "objType")) {
                this.setUoType_(options.objType);
            }

            if (!("uoId" in this.config)){
                this.config.uoId = 0;
            }

            // Logger
            this.logger = options.logger || function(){};

            // Configure retry handler.
            if (eb.misc.isDefined(options, "retryHandler")) {
                this.retryHandler = options.retryHandler;
            } else {
                this.retryHandler = new RetryHandler(ebextend(true, {maxAttempts: 3}, options.retry || {}));
            }

            return this;
        };

        /**
         * Prepares a configuration for request object from the internal configuration.
         */
        this.prepareConfigRequest = function(fromConfig){
            var srcCfg = fromConfig === undefined ? this.config : fromConfig;
            var tmpCfg = ebextend(true, {}, srcCfg);
            var isDefined = eb.misc.isDefined;
            var ak = eb.misc.absorbKeyIfNotSet;

            // If configuration is defined, we can take some settings from there.
            if (isDefined(srcCfg, "config")){
                var config = srcCfg.config;

                ak(tmpCfg, 'host', config, 'endpointEnroll');
                ak(tmpCfg, 'endpoint', config, 'endpointEnroll');
                ak(tmpCfg, 'apiKey', config, 'apiKey');
                ak(tmpCfg, 'requestTimeout', config, 'timeout');
                ak(tmpCfg, 'retryHandler', config, 'retryHandler');
            }

            return tmpCfg;
        };

        /**
         * Returns UOtype corresponding to the RSA decryption key of the given bit size.
         * @param bitsize
         * @returns {number}
         */
        this.getRSAUO = function(bitsize){
            if (bitsize == 1024) {
                return eb.comm.createUO.consts.uoType.RSA1024DECRYPT_NOPAD;
            } else if (bitsize == 2048){
                return eb.comm.createUO.consts.uoType.RSA2048DECRYPT_NOPAD;
            } else {
                throw new eb.exception.invalid(sprintf('Unrecognized RSA type: %d bits', bitsize));
            }
        };

        /**
         * Creates RSA private key in the EB - specialized method for creating UOs.
         * @param data
         */
        this.createRSA = function(data){
            data = data || {};

            // Absorb new configuration data to the global configuration
            var allData = ebextend(true, {}, data || {});
            allData = ebextend(true, allData, this.config || {});

            // Determine number of bits, set UO from that.
            var bits = 2048;
            var isDefined = eb.misc.isDefined;
            if (isDefined(this.config, 'bits')){
                bits = this.config.bits;
            }

            // Reconfigure with old configuration + new derived data - bits.
            allData.bits = bits;
            allData.objType = this.getRSAUO(bits);
            this.configure(allData);

            // Create UO, then extract public key from it.
            return new Promise((function(resolve, reject) {
                var createPromise = this.call();
                createPromise.then(function(data){
                    if (!eb.misc.isDefined(data.result, 'publickey')){
                        throw new eb.exception.invalid('Invalid response - no publickey component');
                    }

                    // Extract public key data, augment response with RSAPrivateKey object.
                    var pubkey = data.result.publickey;
                    var pubComponents = eb.comm.createUO.utils.readSerializedPubKey(pubkey);

                    data.rsaPrivateKey = new eb.client.RSAPrivateKey(ebextend(true, {
                        uo: data.uo
                    }, pubComponents));

                    resolve(data);

                }).catch(function(err){
                    reject(err);
                });

            }).bind(this));
        };

        /**
         * Constructs createUO request - method for creating a general object.
         * Returns promise on the result.
         *
         * @param [data] Configuration
         * @returns {Promise}
         */
        this.call = function(data){
            return new Promise((function(resolve, reject) {
                if (data !== undefined){
                    this.configure(data);
                }

                // Minor sanity checking
                if (this.uoRequest === undefined || this.uoRequest.type === undefined){
                    throw new eb.exception.invalid('UOtype is not defined');
                }

                // EB function to call, forward definition.
                var ebOpFnc = undefined;

                // Success handler - reset retry handler, call success CB.
                var onEbOpSuccess = (function(data){
                    this.retryHandler.reset();
                    this.onTemplateFetched_(data, resolve, reject);
                }).bind(this);

                // Failure handler - try to retry if limit is not reached.
                var onEbOpFailure = (function(data){
                    if (this.retryHandler.limitReached()){
                        this.logger("EB failure - limit reached");
                        reject(ebextend(true, data, {retry:{'reason':'retry attempts limit reached', phase:1}}));
                        return;
                    }

                    var interval = this.retryHandler.retry(ebOpFnc.bind(this));
                    this.onRetry({'interval': interval, 'scheme':this});
                    this.logger(sprintf("EB failure[%s], next attempt: %s ms", this.retryHandler.numAttempts(), interval));
                }).bind(this);

                // Call EB operation.
                ebOpFnc = (function(){
                    this.getTpl_(onEbOpSuccess.bind(this), onEbOpFailure.bind(this));
                }).bind(this);

                // First call/kick off.
                this.retryHandler.reset();
                ebOpFnc();

            }).bind(this));
        };

        this.hasAppKey_ = function(){
            if (this.keys === undefined){
                return false;
            }
            return "app" in this.keys;
        };

        this.hasCommKey_ = function(){
            if (this.keys === undefined){
                return false;
            }
            return "comenc" in this.keys && "commac" in this.keys;
        };

        /**
         * Sets the user object type, sets flags of the key generation w.r.t. keys dict.
         * @param uoType
         * @returns {*}
         * @private
         */
        this.setUoType_ = function(uoType){
            uoType = eb.misc.inputToHexNum(uoType);
            uoType = this.getUoType(uoType, this.hasCommKey_(), this.hasAppKey_());

            this.uoRequest = this.uoRequest || {};
            this.uoRequest.type = uoType;
            return uoType;
        };

        this.getUoType = function(uoType, comm_keys_provided, app_keys_provided){
            if (!comm_keys_provided) {
                uoType &= ~(1<<20);
            } else {
                uoType |= (1<<20);
            }

            if (!app_keys_provided) {
                uoType &= ~(1<<21);
            } else {
                uoType |= (1<<21);
            }

            return uoType;
        };

        /**
         * Performs getTemplate() call, internal.
         * Calls appropriate callbacks. No retry handler.
         *
         * @param onSuccess
         * @param onFail
         * @private
         */
        this.getTpl_ = function(onSuccess, onFail){
            this.tplRequest = new eb.comm.createUO.getUOTemplateRequest();
            this.tplRequest.configure(this.prepareConfigRequest());
            this.tplRequest.logger = this.logger;

            // Build new request data with extending default once.
            // Fixup generation flags in the TPL request accroding to the keys given.
            var requestData = ebextend(true, {
                "generation": {
                    "commkey": this.hasCommKey_() ? eb.comm.createUO.consts.genKey.CLIENT : eb.comm.createUO.consts.genKey.LEGACY_RANDOM,
                    "billingkey": eb.comm.createUO.consts.genKey.LEGACY_RANDOM,
                    "appkey": this.hasAppKey_() ? eb.comm.createUO.consts.genKey.CLIENT : eb.comm.createUO.consts.genKey.LEGACY_RANDOM
                }
            }, this.uoRequest);

            // Fix UOtype based on the generation.
            this.setUoType_(requestData.type);

            // Callbacks settings.
            this.tplRequest.done(function(response, requestObj, data) {
                if (response === undefined
                    || !eb.misc.isDefined(response, "statusCode")
                    || response.statusCode != eb.comm.status.SW_STAT_OK)
                {
                    onFail({response:response, data:data});
                    return;
                }

                onSuccess(response);

            }).fail(function(failType, data){
                onFail(data);

            });

            // Build && submit;
            this.tplRequest.build(requestData);
            this.tplRequest.doRequest();
        };

        /**
         * Performs importUo on given input data.
         * Uses class data (readonly), no retry handler.
         *
         * @param data
         * @param onSuccess
         * @param onFail
         * @private
         */
        this.importUo_ = function(data, onSuccess, onFail){
            this.impRequest = new eb.comm.createUO.importUORequest();
            this.impRequest.configure(this.prepareConfigRequest());
            this.impRequest.logger = this.logger;

            var requestData = {
                "objectid": data.templateResponse.uot.objectid,
                "importkey": data.request.keyUsed.id,
                "object": eb.misc.inputToHex(data.request.uo),
                "authorization": data.templateResponse.uot.authorization
            };

            // Callbacks settings.
            this.impRequest.done(function(response, requestObj, data) {
                if (response === undefined
                    || !eb.misc.isDefined(response, "statusCode")
                    || response.statusCode != eb.comm.status.SW_STAT_OK)
                {
                    onFail({response:response, data:data});
                    return;
                }

                onSuccess(response);

            }).fail(function(failType, data){
                onFail(data);
            });

            // Build && submit;
            this.impRequest.build(requestData);
            this.impRequest.doRequest();
        };

        /**
         * Processes getTemplate() response and calls importUo call.
         *
         * @param response
         * @param onSuccess
         * @param onFail
         * @private
         */
        this.importUoWithResponse_ = function(response, onSuccess, onFail){
            // Create a new user object.
            var tpl = response.uot;
            var builder = new eb.comm.createUO.templateFiller({template: tpl, logger: this.logger});

            // New next keys - if not present.
            if (!eb.misc.isDefined(this.keys, "comnextenc")
                || this.keys.comnextenc === undefined
                || this.keys.comnextenc.key === undefined
                || !eb.misc.isDefined(this.keys, "comnextmac")
                || this.keys.comnextmac === undefined
                || this.keys.comnextmac.key === undefined)
            {
                var keys = ebextend(true, {
                    comnextenc:{
                        key:sjcl.random.randomWords(8)},
                    comnextmac:{
                        key:sjcl.random.randomWords(8)}
                }, this.keys);
            }

            this.keys = keys; // update current keys to reflect reality
            var buildReq = builder.build({keys: keys});

            // Copy to the state
            this.templateResponse = response;
            this.tplUsed = tpl;

            // Create a new request.
            var data = {templateResponse: response, template:tpl, request: buildReq};
            this.importUo_(data, onSuccess, onFail);
        };

        /**
         * Called after template was successfully fetched. Takes promise resolve, reject.
         * Performs importUo with retry.
         *
         * @param response
         * @param resolve
         * @param reject
         * @private
         */
        this.onTemplateFetched_ = function(response, resolve, reject){
            // EB function to call, forward definition.
            var ebOpFnc = undefined;

            // Success handler - reset retry handler, call success CB.
            var onEbOpSuccess = (function(data){
                this.retryHandler.reset();
                this.onUoImportFinished_(data, resolve, reject);
            }).bind(this);

            // Failure handler - try to retry if limit is not reached.
            var onEbOpFailure = (function(data){
                if (this.retryHandler.limitReached()){
                    this.logger("EB failure - limit reached");
                    reject(ebextend(true, data, {retry:{'reason':'retry attempts limit reached', phase:2}}));
                    return;
                }

                var interval = this.retryHandler.retry(ebOpFnc.bind(this));
                this.onRetry({'interval': interval, 'scheme':this});
                this.logger(sprintf("EB failure[%s], next attempt: %s ms", this.retryHandler.numAttempts(), interval));
            }).bind(this);

            // Call EB operation.
            ebOpFnc = (function(){
                this.importUoWithResponse_(response, onEbOpSuccess.bind(this), onEbOpFailure.bind(this));
            }).bind(this);

            // First call/kick off.
            this.retryHandler.reset();
            ebOpFnc();
        };

        /**
         * Event called when import UO is successful. Uses promise resolve/reject callbacks.
         *
         * @param response
         * @param resolve
         * @param reject
         * @private
         */
        this.onUoImportFinished_ = function(response, resolve, reject){
            this.importResponse = response;

            // Augmenting result of createUO operation.
            // 1. Attach configuration if any
            if (eb.misc.isDefined(this.config, "config")) {
                response.config = this.config.config;
            }

            // 2. Create UO
            var handleParsed = eb.comm.parseHandle(response.result.handle);
            this.uo = new eb.client.UO({
                uoId: handleParsed.uoId,
                uoType: handleParsed.uoType,
                apiKey: handleParsed.apiKey,
                encKey: this.keys.comenc.key,
                macKey: this.keys.commac.key,
                configuration: eb.misc.isDefined(this.config, "config") ? this.config.config : undefined
            });

            response.uo = this.uo;
            resolve(response);
        };

        this.onRetry = function(data){
            this.triggerEvent("retry", data);
        };

        this.triggerEvent = function(evt, data){
            this.listeners[evt] = this.listeners[evt] || [];
            for(var i = 0, ln = this.listeners[evt].length; i < ln; i++){
                this.listeners[evt][i](data);
            }
        };

        this.listen = function(evt, listener){
            this.listeners[evt] = this.listeners[evt] || [];
            this.listeners[evt].push(listener);
            return this;
        };

        this.unlisten = function(evt, listener){
            this.listeners[evt] = this.listeners[evt] || [];

            for(var i = 0, ln = this.listeners[evt].length; i < ln; i++){
                if(this.listeners[evt][i] === listener) {
                    this.listeners[evt].splice(i,1);
                    return this;
                }
            }
            return this;
        };

        this.cancel = function(data){
            this.retryHandler.cancel();
            return this;
        };

        this.retry = function(data){
            // TODO: this
            return this;
        };

        // Configure
        this.configure(options);
    }
};

if(typeof exports !== 'undefined'){
    exports = module.exports = eb;
}
if (typeof define === "function") {
    /*globals define:false */
    define([], function () {
        return eb;
    });
}
