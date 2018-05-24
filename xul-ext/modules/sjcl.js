"use strict";

var sjcl = {
    cipher: {},
    hash: {},
    keyexchange: {},
    mode: {},
    misc: {},
    codec: {},
    exception: {
        corrupt: function (a) {
            this.toString = function () {
                return "CORRUPT: " + this.message
            };
            this.message = a
        },
        invalid: function (a) {
            this.toString = function () {
                return "INVALID: " + this.message
            };
            this.message = a
        },
        bug: function (a) {
            this.toString = function () {
                return "BUG: " + this.message
            };
            this.message = a
        },
        notReady: function (a) {
            this.toString = function () {
                return "NOT READY: " + this.message
            };
            this.message = a
        }
    }
};

"undefined" != typeof module && module.exports && (module.exports = sjcl);

sjcl.cipher.aes = function (a) {
    if (!this.a[0][0][0]) {
        var b = this.a[0],
            d = this.a[1],
            c = b[4],
            e = d[4],
            h, g, f, k = [],
            p = [],
            q, m, l, n;
        for (h = 0; 0x100 > h; h++) p[(k[h] = h << 1 ^ 283 * (h >> 7)) ^ h] = h;
        for (g = f = 0; !c[g]; g ^= q || 1, f = p[f] || 1) {
            l = f ^ f << 1 ^ f << 2 ^ f << 3 ^ f << 4;
            l = l >> 8 ^ l & 255 ^ 99;
            c[g] = l;
            e[l] = g;
            m = k[h = k[q = k[g]]];
            n = 0x1010101 * m ^ 0x10001 * h ^ 0x101 * q ^ 0x1010100 * g;
            m = 0x101 * k[l] ^ 0x1010100 * l;
            for (h = 0; 4 > h; h++) b[h][g] = m = m << 24 ^ m >>> 8, d[h][l] = n = n << 24 ^ n >>> 8
        }
        for (h = 0; 5 > h; h++) b[h] = b[h].slice(0), d[h] = d[h].slice(0)
    }
    b = this.a[0][4];
    d = this.a[1];
    f = a.length;
    k = 1;
    if (4 !== f && 6 !== f &&
        8 !== f) throw new sjcl.exception.invalid("invalid aes key size");
    this.e = [e = a.slice(0), g = []];
    for (a = f; a < 4 * f + 28; a++) {
        c = e[a - 1];
        if (0 === a % f || 8 === f && 4 === a % f) c = b[c >>> 24] << 24 ^ b[c >> 16 & 255] << 16 ^ b[c >> 8 & 255] << 8 ^ b[c & 255], 0 === a % f && (c = c << 8 ^ c >>> 24 ^ k << 24, k = k << 1 ^ 283 * (k >> 7));
        e[a] = e[a - f] ^ c
    }
    for (f = 0; a; f++ , a--) c = e[f & 3 ? a : a - 4], g[f] = 4 >= a || 4 > f ? c : d[0][b[c >>> 24]] ^ d[1][b[c >> 16 & 255]] ^ d[2][b[c >> 8 & 255]] ^ d[3][b[c & 255]]
};

sjcl.cipher.aes.prototype = {
    encrypt: function (a) {
        return v(this, a, 0)
    },
    decrypt: function (a) {
        return v(this, a, 1)
    },
    a: [
        [
            [],
            [],
            [],
            [],
            []
        ],
        [
            [],
            [],
            [],
            [],
            []
        ]
    ]
};

function v(a, b, d) {
    if (4 !== b.length) throw new sjcl.exception.invalid("invalid aes block size");
    var c = a.e[d],
        e = b[0] ^ c[0],
        h = b[d ? 3 : 1] ^ c[1],
        g = b[2] ^ c[2];
    b = b[d ? 1 : 3] ^ c[3];
    var f, k, p, q = c.length / 4 - 2,
        m, l = 4,
        n = [0, 0, 0, 0];
    f = a.a[d];
    a = f[0];
    var r = f[1],
        s = f[2],
        t = f[3],
        u = f[4];
    for (m = 0; m < q; m++) f = a[e >>> 24] ^ r[h >> 16 & 255] ^ s[g >> 8 & 255] ^ t[b & 255] ^ c[l], k = a[h >>> 24] ^ r[g >> 16 & 255] ^ s[b >> 8 & 255] ^ t[e & 255] ^ c[l + 1], p = a[g >>> 24] ^ r[b >> 16 & 255] ^ s[e >> 8 & 255] ^ t[h & 255] ^ c[l + 2], b = a[b >>> 24] ^ r[e >> 16 & 255] ^ s[h >> 8 & 255] ^ t[g & 255] ^ c[l + 3], l += 4, e = f, h = k, g = p;
    for (m = 0; 4 > m; m++) n[d ? 3 & -m : m] = u[e >>> 24] << 24 ^ u[h >> 16 & 255] << 16 ^ u[g >> 8 & 255] << 8 ^ u[b & 255] ^ c[l++], f = e, e = h, h = g, g = b, b = f;
    return n
}

sjcl.bitArray = {
    bitSlice: function (a, b, d) {
        a = sjcl.bitArray.c(a.slice(b / 32), 32 - (b & 31)).slice(1);
        return void 0 === d ? a : sjcl.bitArray.clamp(a, d - b)
    },
    extract: function (a, b, d) {
        var c = Math.floor(-b - d & 31);
        return ((b + d - 1 ^ b) & -32 ? a[b / 32 | 0] << 32 - c ^ a[b / 32 + 1 | 0] >>> c : a[b / 32 | 0] >>> c) & (1 << d) - 1
    },
    concat: function (a, b) {
        if (0 === a.length || 0 === b.length) return a.concat(b);
        var d = a[a.length - 1],
            c = sjcl.bitArray.getPartial(d);
        return 32 === c ? a.concat(b) : sjcl.bitArray.c(b, c, d | 0, a.slice(0, a.length - 1))
    },
    bitLength: function (a) {
        var b = a.length;
        return 0 ===
            b ? 0 : 32 * (b - 1) + sjcl.bitArray.getPartial(a[b - 1])
    },
    clamp: function (a, b) {
        if (32 * a.length < b) return a;
        a = a.slice(0, Math.ceil(b / 32));
        var d = a.length;
        b &= 31;
        0 < d && b && (a[d - 1] = sjcl.bitArray.partial(b, a[d - 1] & 2147483648 >> b - 1, 1));
        return a
    },
    partial: function (a, b, d) {
        return 32 === a ? b : (d ? b | 0 : b << 32 - a) + 0x10000000000 * a
    },
    getPartial: function (a) {
        return Math.round(a / 0x10000000000) || 32
    },
    equal: function (a, b) {
        if (sjcl.bitArray.bitLength(a) !== sjcl.bitArray.bitLength(b)) return !1;
        var d = 0,
            c;
        for (c = 0; c < a.length; c++) d |= a[c] ^ b[c];
        return 0 ===
            d
    },
    c: function (a, b, d, c) {
        var e;
        e = 0;
        for (void 0 === c && (c = []); 32 <= b; b -= 32) c.push(d), d = 0;
        if (0 === b) return c.concat(a);
        for (e = 0; e < a.length; e++) c.push(d | a[e] >>> b), d = a[e] << 32 - b;
        e = a.length ? a[a.length - 1] : 0;
        a = sjcl.bitArray.getPartial(e);
        c.push(sjcl.bitArray.partial(b + a & 31, 32 < b + a ? d : c.pop(), 1));
        return c
    },
    d: function (a, b) {
        return [a[0] ^ b[0], a[1] ^ b[1], a[2] ^ b[2], a[3] ^ b[3]]
    }
};

sjcl.codec.utf8String = {
    fromBits: function (a) {
        var b = "",
            d = sjcl.bitArray.bitLength(a),
            c, e;
        for (c = 0; c < d / 8; c++) 0 === (c & 3) && (e = a[c / 4]), b += String.fromCharCode(e >>> 24), e <<= 8;
        return decodeURIComponent(escape(b))
    },
    toBits: function (a) {
        a = unescape(encodeURIComponent(a));
        var b = [],
            d, c = 0;
        for (d = 0; d < a.length; d++) c = c << 8 | a.charCodeAt(d), 3 === (d & 3) && (b.push(c), c = 0);
        d & 3 && b.push(sjcl.bitArray.partial(8 * (d & 3), c));
        return b
    }
};

sjcl.codec.hex = {
    fromBits: function (a) {
        var b = "",
            d;
        for (d = 0; d < a.length; d++) b += ((a[d] | 0) + 0xf00000000000).toString(16).substr(4);
        return b.substr(0, sjcl.bitArray.bitLength(a) / 4)
    },
    toBits: function (a) {
        var b, d = [],
            c;
        a = a.replace(/\s|0x/g, "");
        c = a.length;
        a += "00000000";
        for (b = 0; b < a.length; b += 8) d.push(parseInt(a.substr(b, 8), 16) ^ 0);
        return sjcl.bitArray.clamp(d, 4 * c)
    }
};

sjcl.codec.base64 = {
    b: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    fromBits: function (a, b, d) {
        var c = "",
            e = 0,
            h = sjcl.codec.base64.b,
            g = 0,
            f = sjcl.bitArray.bitLength(a);
        d && (h = h.substr(0, 62) + "-_");
        for (d = 0; 6 * c.length < f;) c += h.charAt((g ^ a[d] >>> e) >>> 26), 6 > e ? (g = a[d] << 6 - e, e += 26, d++) : (g <<= 6, e -= 6);
        for (; c.length & 3 && !b;) c += "=";
        return c
    },
    toBits: function (a, b) {
        a = a.replace(/\s|=/g, "");
        var d = [],
            c, e = 0,
            h = sjcl.codec.base64.b,
            g = 0,
            f;
        b && (h = h.substr(0, 62) + "-_");
        for (c = 0; c < a.length; c++) {
            f = h.indexOf(a.charAt(c));
            if (0 > f) throw new sjcl.exception.invalid("this isn't base64!");
            26 < e ? (e -= 26, d.push(g ^ f >>> e), g = f << 32 - e) : (e += 6, g ^= f << 32 - e)
        }
        e & 56 && d.push(sjcl.bitArray.partial(e & 56, g, 1));
        return d
    }
};

sjcl.codec.base64url = {
    fromBits: function (a) {
        return sjcl.codec.base64.fromBits(a, 1, 1)
    },
    toBits: function (a) {
        return sjcl.codec.base64.toBits(a, 1)
    }
};

sjcl.codec.bytes = {
    fromBits: function (a) {
        var b = [],
            d = sjcl.bitArray.bitLength(a),
            c, e;
        for (c = 0; c < d / 8; c++) 0 === (c & 3) && (e = a[c / 4]), b.push(e >>> 24), e <<= 8;
        return b
    },
    toBits: function (a) {
        var b = [],
            d, c = 0;
        for (d = 0; d < a.length; d++) c = c << 8 | a[d], 3 === (d & 3) && (b.push(c), c = 0);
        d & 3 && b.push(sjcl.bitArray.partial(8 * (d & 3), c));
        return b
    }
};

void 0 === sjcl.beware && (sjcl.beware = {});

sjcl.beware["CBC mode is dangerous because it doesn't protect message integrity."] = function () {
    sjcl.mode.cbc = {
        name: "cbc",
        encrypt: function (a, b, d, c) {
            if (c && c.length) throw new sjcl.exception.invalid("cbc can't authenticate data");
            if (128 !== sjcl.bitArray.bitLength(d)) throw new sjcl.exception.invalid("cbc iv must be 128 bits");
            var e = sjcl.bitArray,
                h = e.d,
                g = e.bitLength(b),
                f = 0,
                k = [];
            if (g & 7) throw new sjcl.exception.invalid("pkcs#5 padding only works for multiples of a byte");
            for (c = 0; f + 128 <= g; c += 4, f += 128) d = a.encrypt(h(d,
                b.slice(c, c + 4))), k.splice(c, 0, d[0], d[1], d[2], d[3]);
            g = 0x1010101 * (16 - (g >> 3 & 15));
            d = a.encrypt(h(d, e.concat(b, [g, g, g, g]).slice(c, c + 4)));
            k.splice(c, 0, d[0], d[1], d[2], d[3]);
            return k
        },
        decrypt: function (a, b, d, c) {
            if (c && c.length) throw new sjcl.exception.invalid("cbc can't authenticate data");
            if (128 !== sjcl.bitArray.bitLength(d)) throw new sjcl.exception.invalid("cbc iv must be 128 bits");
            if (sjcl.bitArray.bitLength(b) & 127 || !b.length) throw new sjcl.exception.corrupt("cbc ciphertext must be a positive multiple of the block size");
            var e = sjcl.bitArray,
                h = e.d,
                g, f = [];
            for (c = 0; c < b.length; c += 4) g = b.slice(c, c + 4), d = h(d, a.decrypt(g)), f.splice(c, 0, d[0], d[1], d[2], d[3]), d = g;
            g = f[c - 1] & 255;
            if (0 == g || 16 < g) throw new sjcl.exception.corrupt("pkcs#5 padding corrupt");
            d = 0x1010101 * g;
            if (!e.equal(e.bitSlice([d, d, d, d], 0, 8 * g), e.bitSlice(f, 32 * f.length - 8 * g, 32 * f.length))) throw new sjcl.exception.corrupt("pkcs#5 padding corrupt");
            return e.bitSlice(f, 0, 32 * f.length - 8 * g)
        }
    }
};
