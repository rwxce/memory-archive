// Synthetic Catalan "showcase" exports for the README screenshots (`pnpm screenshots`).
// Invented people, invented messages, generated pictures; nothing here comes from a real
// chat. Output is deterministic (seeded PRNG, no clock), written to fixtures/showcase/.
//
// Called from scripts/generate-fixtures.mjs. Android, Catalan, D/M/YY 24h. The owner is "Tu".
// Photos are small valid PNGs drawn from code (soft sky, sun, hills in the design's pastel
// palette). Voice notes are valid quiet WAV bytes under a `.opus` name: browsers sniff the
// content, so the audio element reads a real duration.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { zipSync } from 'fflate';

export const OWNER = 'Tu';

const PALETTE = ['#B8A8FF', '#FFB49E', '#8FD9C0', '#FFD66B', '#7FA7FF', '#F49AC1', '#C7B8FF', '#9EE3CF'];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Small deterministic PRNG (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal RGB8 PNG encoder. `rgb` is width*height*3 bytes. */
export function encodeRgbPng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * stride + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A soft "landscape": vertical gradient sky, a sun, two rolling hills. Seeded, so every photo
 * differs but the same seed always gives the same bytes.
 */
export function makePhoto(seed, width = 360, height = 270) {
  const r = prng(seed * 7919 + 13);
  const sky = hex(PALETTE[seed % PALETTE.length]);
  const sky2 = mix(sky, [255, 255, 255], 0.55);
  const hillA = mix(hex(PALETTE[(seed + 2) % PALETTE.length]), [60, 70, 90], 0.18);
  const hillB = mix(hex(PALETTE[(seed + 5) % PALETTE.length]), [40, 50, 70], 0.28);
  const sun = mix(hex(PALETTE[(seed + 3) % PALETTE.length]), [255, 255, 255], 0.5);
  const sx = width * (0.2 + r.next() * 0.6);
  const sy = height * (0.2 + r.next() * 0.2);
  const sr = height * (0.08 + r.next() * 0.06);
  const phaseA = r.next() * 6;
  const phaseB = r.next() * 6;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c = mix(sky2, sky, y / height);
      const d = Math.hypot(x - sx, y - sy);
      if (d < sr * 2.2) c = mix(c, sun, Math.max(0, 0.5 - d / (sr * 4.4)));
      if (d < sr) c = sun;
      const ha = height * (0.62 + 0.07 * Math.sin(x / 55 + phaseA));
      const hb = height * (0.76 + 0.06 * Math.sin(x / 38 + phaseB));
      if (y > ha) c = mix(hillA, [255, 255, 255], 0.1 * Math.sin(y / 9) + 0.05);
      if (y > hb) c = hillB;
      const i = (y * width + x) * 3;
      rgb[i] = c[0];
      rgb[i + 1] = c[1];
      rgb[i + 2] = c[2];
    }
  }
  return encodePng(width, height, rgb);
}
const encodePng = encodeRgbPng;

/**
 * A very quiet 8-bit mono WAV, `seconds` long: a faint hum plus seeded dither. Pure silence would
 * deflate to nothing and trip the importer's zip-bomb ratio check (100x), as it should; the dither
 * keeps the ratio near 3x, like a real voice note.
 */
export function makeQuietWav(seconds, rate = 8000) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n);
  const r = prng(Math.round(seconds * 1000) + 7);
  for (let i = 0; i < n; i++) {
    const hum = 6 * Math.sin((2 * Math.PI * 180 * i) / rate);
    buf[44 + i] = 0x80 + Math.round(hum + (r.next() - 0.5) * 8);
  }
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n, 40);
  return buf;
}

// ---------------------------------------------------------------------------
// Chat builder
// ---------------------------------------------------------------------------

const p2 = (n) => String(n).padStart(2, '0');

class Chat {
  constructor(seed) {
    this.rand = prng(seed);
    this.events = []; // { t: Date.UTC-based ms, who, body | media }
    this.media = {}; // file name -> bytes
    this.counter = 0;
    this.photoSeed = seed;
  }

  /** y, m (1-12), d, h, min */
  at(y, m, d, h, min) {
    return Date.UTC(y, m - 1, d, h, min);
  }

  text(t, who, body) {
    this.events.push({ t, who, body });
  }

  photo(t, who, caption) {
    const d = new Date(t);
    const n = ++this.counter;
    const name = `IMG-${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-WA${String(n).padStart(4, '0')}.png`;
    this.media[name] = makePhoto(this.photoSeed++);
    this.events.push({ t, who, media: name, body: caption });
  }

  voice(t, who, seconds) {
    const d = new Date(t);
    const n = ++this.counter;
    const name = `PTT-${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-WA${String(n).padStart(4, '0')}.opus`;
    this.media[name] = makeQuietWav(seconds);
    this.events.push({ t, who, media: name });
  }

  deleted(t, who) {
    this.events.push({ t, who, body: who === OWNER ? 'Has suprimit aquest missatge.' : "S'ha suprimit aquest missatge." });
  }

  /** Android Catalan: `D/M/YY H:mm - Who: body`; media as `file (fitxer adjunt)` + caption lines. */
  render(system = []) {
    const stamp = (t) => {
      const d = new Date(t);
      return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${p2(d.getUTCFullYear() % 100)} ${d.getUTCHours()}:${p2(d.getUTCMinutes())}`;
    };
    const lines = system.map(([t, text]) => `${stamp(t)} - ${text}`);
    const sorted = [...this.events].sort((a, b) => a.t - b.t);
    for (const e of sorted) {
      if (e.media) {
        lines.push(`${stamp(e.t)} - ${e.who}: ${e.media} (fitxer adjunt)`);
        if (e.body) lines.push(e.body);
      } else {
        lines.push(`${stamp(e.t)} - ${e.who}: ${e.body}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  zip(dir, name, system) {
    const files = { '_chat.txt': Buffer.from(this.render(system), 'utf8'), ...this.media };
    fs.writeFileSync(path.join(dir, `WhatsApp Chat - ${name}.zip`), Buffer.from(zipSync(files, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) })));
  }

  /**
   * Spreads `count` pieces of small talk over the years in proportion to `weights`.
   * `pools` is `{ who: [phrases...] }`; senders are drawn at random, phrases cycle with variety.
   */
  scatter(years, weights, count, speakers, phrases, { hours = [7, 22] } = {}) {
    const total = weights.reduce((a, b) => a + b, 0);
    years.forEach((y, yi) => {
      const n = Math.round((count * weights[yi]) / total);
      for (let i = 0; i < n; i++) {
        const m = 1 + this.rand.int(12);
        const d = 1 + this.rand.int(28);
        const h = hours[0] + this.rand.int(hours[1] - hours[0]);
        const min = this.rand.int(60);
        const t = this.at(y, m, d, h, min);
        // a short back-and-forth: 1 to 3 consecutive messages a few minutes apart
        const run = 1 + this.rand.int(3);
        let who = this.rand.pick(speakers);
        for (let k = 0; k < run; k++) {
          this.text(t + k * (60_000 + this.rand.int(240_000)), who, this.rand.pick(phrases));
          who = this.rand.pick(speakers);
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// The six chats
// ---------------------------------------------------------------------------

const YEARS_MAMA = [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
const YEAR_WEIGHTS = [18, 30, 26, 44, 52, 38, 60, 72, 64, 90, 48];

function mama() {
  const c = new Chat(101);
  const M = 'Mama';
  const small = [
    'Ja has dinat?',
    'Avui fa un dia preciós, hauries de sortir a passejar.',
    "No t'oblidis de trucar a l'àvia.",
    'Descansa, que deus estar cansat.',
    'Et trobo a faltar. Quan vens?',
    'He fet pastís de poma, no et diré per a qui.',
    "T'he deixat un tupper a la nevera.",
    "Aquesta tarda tinc l'hort per fer.",
    'Quin fred que fa avui!',
    'Truca\'m quan puguis, sense pressa.',
    "Ja he regat les plantes, tranquil·la.",
    'Passa-ho molt bé, i vés amb compte.',
    'Gràcies per la trucada, m\'ha fet il·lusió.',
    'Un petó molt gran.',
    'Què vols per sopar?',
    "He vist en Marc pel poble, tan alt que està!",
    "Demà plourà, agafa el paraigua.",
    'Bona nit, descansa bé.',
    'Perfecte, ens veiem diumenge.',
    "T'estimo molt.",
  ];
  const mine = [
    'Sí, acabo de dinar.',
    'Ara et truco, mama.',
    'Gràcies per tot, de veritat.',
    "Demà t'ho explico amb calma.",
    'Que bona pinta!',
    'Em fa il·lusió veure-us.',
    'Arribo cap a les vuit.',
    'Perfecte, així ho fem.',
    "Tinc moltes ganes d'aquell cafè.",
    'Un petó, bona nit.',
  ];
  // Both sides in one pool: Mama writes more than Tu.
  c.scatter(YEARS_MAMA, YEAR_WEIGHTS, 330, [M, M, OWNER], [...small, ...mine]);

  // Anchor days from the design.
  c.text(c.at(2019, 9, 14, 8, 42), M, 'Bon dia, carinyo. Has dormit bé?');
  c.photo(c.at(2019, 9, 14, 8, 44), M, 'Mira com han quedat les tomaqueres');
  c.text(c.at(2019, 9, 14, 9, 10), OWNER, 'Quina meravella! Aquest any sí que hi haurà salsa per a tothom');
  c.voice(c.at(2019, 9, 14, 9, 12), M, 42);
  c.text(c.at(2019, 9, 15, 12, 3), M, 'Vens a dinar? He fet canelons');
  c.text(c.at(2019, 9, 15, 12, 20), OWNER, 'Arribo a la una i mitja');
  c.deleted(c.at(2019, 9, 15, 12, 31), M);
  c.text(c.at(2019, 9, 15, 12, 35), M, "Perdona, m'he equivocat de xat. Doncs a la una i mitja!");
  c.text(c.at(2016, 7, 3, 19, 5), M, "Quan tornis de viatge, porta'm una postal, encara que sigui de l'aeroport.");
  c.text(c.at(2016, 7, 3, 19, 8), OWNER, 'Tracte fet. Te la compro al primer quiosc que vegi.');
  c.text(c.at(2022, 6, 20, 17, 2), M, 'Sempre ho dic: el millor moment del dia és el cafè de les cinc.');
  c.text(c.at(2022, 6, 20, 17, 4), OWNER, "I jo me'n recordo cada tarda, mama.");
  c.text(c.at(2021, 8, 9, 10, 15), M, 'Les tomaqueres han donat molt aquest estiu.');
  c.text(c.at(2023, 5, 2, 11, 40), OWNER, 'Has plantat tomaqueres també enguany?');
  c.text(c.at(2018, 12, 25, 9, 30), M, 'Bon Nadal, vida meva! Escalfa el caldo que et vaig deixar.');
  c.text(c.at(2024, 3, 9, 18, 22), OWNER, 'Et truco demà al matí, que avui he arribat tard.');
  // The most recent chat in the archive, so Mama leads the People list.
  c.text(c.at(2024, 12, 30, 20, 10), M, 'Bon any nou, carinyo! Que et sigui molt bo.');

  // Photos spread over the years (a gallery needs months to group by).
  // [year, month, day, how many]: bursts from trips and family days, so months fill a grid.
  const photoDays = [
    [2014, 6, 14, 5], [2015, 4, 5, 4], [2015, 9, 12, 6], [2016, 8, 22, 3], [2017, 3, 19, 2], [2017, 10, 7, 4],
    [2018, 5, 27, 3], [2018, 8, 15, 5], [2019, 2, 16, 2], [2019, 8, 31, 6], [2019, 9, 22, 4], [2020, 4, 11, 2],
    [2020, 12, 6, 3], [2021, 6, 1, 4], [2021, 9, 18, 5], [2022, 3, 12, 3], [2022, 7, 30, 6], [2022, 11, 20, 3],
    [2023, 2, 25, 2], [2023, 5, 14, 4], [2023, 8, 19, 5], [2023, 10, 28, 3], [2024, 1, 20, 2], [2024, 3, 23, 4],
    [2024, 6, 8, 3], [2024, 8, 25, 5],
  ];
  const captions = ['', 'Mira què he trobat', '', 'El jardí aquest matí', '', 'Ja floreixen!', '', "Les postres d'avui", ''];
  let shot = 0;
  photoDays.forEach(([y, m, d, count]) => {
    for (let k = 0; k < count; k++, shot++) {
      c.photo(c.at(y, m, d, 10 + (k % 8), (shot * 7) % 60), shot % 3 === 0 ? OWNER : M, k === 0 ? captions[shot % captions.length] : '');
    }
  });

  // Voice notes.
  const voiceDays = [[2015, 11, 3, 31], [2017, 5, 9, 18], [2018, 2, 20, 55], [2020, 3, 29, 24], [2021, 12, 24, 63], [2022, 9, 8, 14], [2023, 3, 17, 37], [2024, 5, 5, 26]];
  voiceDays.forEach(([y, m, d, s], i) => c.voice(c.at(y, m, d, 12 + (i % 6), 20 + i), i % 4 === 0 ? OWNER : M, s));

  // A few more deleted messages.
  c.deleted(c.at(2017, 1, 14, 21, 2), M);
  c.deleted(c.at(2020, 10, 3, 13, 12), OWNER);
  c.deleted(c.at(2023, 11, 11, 8, 50), M);
  return c;
}

function avi() {
  const c = new Chat(202);
  const A = 'Avi Josep';
  const phrases = [
    'Com va tot per allà dalt?',
    'Aquí fa un sol que pela.',
    "He anat a pescar amb el veí, no ha picat res.",
    'Què tal els estudis, noi?',
    "Ve't a veure quan puguis, que tinc mel nova.",
    'Gràcies pel regal, és molt bonic.',
    'Bon dia! Ja he fet el cafè.',
    'El futbol d\'ahir va ser un desastre.',
    'No oblidis portar la jaqueta, que a la nit refresca.',
    "T'espero diumenge a la fonda.",
    'Aquest any la collita de raïm és molt bona.',
  ];
  const mine = ['Visca, avi!', 'Ens veiem diumenge.', 'Moltes gràcies per tot.', "Ja t'he trucat, no t'ho agafava.", 'Et porto el que em vas demanar.'];
  c.scatter([2016, 2017, 2018, 2019, 2020, 2021], [10, 22, 26, 20, 28, 14], 70, [A, A, OWNER], [...phrases, ...mine]);
  c.text(c.at(2018, 9, 8, 18, 10), A, 'Aquest any les tomaqueres de la solana han sortit enormes.');
  c.text(c.at(2018, 9, 8, 18, 12), OWNER, 'Pugen bé aquest estiu, és el sol!');
  c.photo(c.at(2017, 7, 9, 11, 0), A, 'La collita del dia');
  c.photo(c.at(2019, 10, 13, 10, 20), A, '');
  c.voice(c.at(2019, 2, 3, 20, 45), A, 51);
  c.voice(c.at(2020, 7, 18, 9, 5), A, 19);
  c.deleted(c.at(2018, 4, 2, 15, 40), A);
  return c;
}

function laia() {
  const c = new Chat(303);
  const L = 'Laia';
  const phrases = [
    'Tu ets boig, ho saps?',
    'Vinga, surt de casa que fa un dia genial.',
    'Mama diu que no truques mai. Fes-ho!',
    'Acabo de sortir de la feina, esgotada.',
    "Reservo taula per dissabte?",
    'No ho puc creure, mira què m\'ha passat!',
    'Gràcies per escoltar-me ahir.',
    'He trobat una foto nostra de petits, la vols?',
    'Em passes la recepta dels canelons?',
    'Bon cap de setmana! Fes alguna cosa divertida.',
    'Et recordes aquell viatge a la costa?',
    "Aviam si ens veiem aviat, ho trobo a faltar.",
  ];
  const mine = ['Boja, tu!', 'Cap de setmana tranquil, i tu?', 'Et truco aquesta nit.', 'Quin riure!', 'Sí, dissabte em va perfecte.', 'Et passo la recepta ara mateix.'];
  c.scatter([2012, 2014, 2016, 2018, 2019, 2020, 2021, 2022, 2023, 2024], [4, 8, 12, 16, 20, 22, 24, 30, 34, 38], 190, [L, OWNER], [...phrases, ...mine]);
  c.text(c.at(2022, 8, 20, 20, 15), L, 'Aquest estiu a casa dels pares les tomaqueres són una bogeria.');
  c.photo(c.at(2021, 5, 2, 19, 30), L, 'Dinar de germanes');
  c.photo(c.at(2023, 8, 14, 15, 10), OWNER, '');
  c.photo(c.at(2024, 12, 25, 21, 0), L, 'Bon Nadal!');
  c.voice(c.at(2022, 1, 9, 22, 5), L, 33);
  c.voice(c.at(2023, 6, 23, 8, 50), OWNER, 12);
  c.deleted(c.at(2021, 11, 4, 10, 2), L);
  return c;
}

function marc() {
  const c = new Chat(404);
  const M = 'Marc';
  const phrases = [
    'Què, anem a fer unes canyes?',
    'Ho he pensat i sí, el cap de setmana soc dels teus.',
    'Has vist el partit? Increïble.',
    'Passa\'m el compte i et faig el Bizum.',
    'Quedem a les set davant del cinema?',
    "Jo porto el vi, tu el formatge, d'acord?",
    'Ha arribat el paquet, gràcies!',
    'Un dia d\'aquests fem una excursió.',
    'T\'agafo al vol, que estic a prop.',
  ];
  const mine = ['Ens veiem allà!', 'Tracte fet.', 'No puc, perdó. La setmana vinent segur.', 'Em sembla fantàstic.'];
  c.scatter([2017, 2018, 2019, 2020, 2021, 2022, 2023], [8, 16, 20, 12, 18, 22, 16], 110, [M, OWNER], [...phrases, ...mine]);
  c.photo(c.at(2019, 6, 22, 14, 30), M, 'Fotos de la ruta');
  c.photo(c.at(2022, 9, 3, 17, 45), OWNER, '');
  c.voice(c.at(2021, 3, 11, 19, 20), M, 22);
  c.deleted(c.at(2020, 5, 15, 12, 30), M);
  return c;
}

function familia() {
  const c = new Chat(505);
  const people = ['Mama', 'Avi Josep', 'Laia', 'Marc', OWNER];
  const phrases = [
    'Bon dia a tots!',
    "Qui porta el pa diumenge?",
    'Jo preparo la carn, que ningú en porti més.',
    'Hola família, ja he arribat.',
    'Felicitats! Que passis un dia genial.',
    "Hi ha lloc per a tots a casa, no patiu.",
    'Que bona pinta que té el pastís!',
    "Ens veiem a la masia a la una?",
    'Recordeu: dinar de Sant Esteve a casa de l\'àvia.',
    'Tinc una bona notícia per a vosaltres.',
    'Visca! Gràcies per tot.',
    "Atenció: aquest diumenge canvi d'hora.",
    "Ja he fet una foto de grup, ara la penjo.",
  ];
  c.scatter([2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024], [10, 20, 26, 24, 30, 28, 34, 38, 24], 230, people, phrases);
  c.photo(c.at(2018, 12, 26, 15, 0), 'Mama', 'Foto de família de Sant Esteve');
  c.photo(c.at(2021, 12, 25, 14, 20), 'Laia', 'Tots a taula!');
  c.photo(c.at(2023, 8, 12, 13, 5), 'Avi Josep', '');
  c.voice(c.at(2020, 4, 13, 20, 10), 'Avi Josep', 28);
  c.deleted(c.at(2019, 3, 3, 9, 5), 'Marc');
  return c;
}

function sopars() {
  const c = new Chat(606);
  const people = ['Pau', 'Núria', 'Jordi', 'Marc', OWNER];
  const phrases = [
    'Aquest dijous qui cuina?',
    "Porto jo el postre, no patiu.",
    'A quina hora quedem?',
    "Les 21:00 al lloc de sempre.",
    'Algú pot portar vi blanc?',
    'Sopar de pizzes aquest dijous?',
    'Ho sento, aquesta setmana no puc.',
    'Quin sopar més bo, repetim aviat!',
    'He reservat taula per a sis.',
    "Heu vist què ha passat avui? Increïble.",
    'Visca els dijous!',
    'Qui apunta la compra?',
  ];
  c.scatter([2021, 2022, 2023, 2024, 2025], [8, 24, 30, 28, 12], 260, people, phrases, { hours: [9, 23] });
  c.photo(c.at(2022, 11, 17, 22, 10), 'Núria', 'Els canelons de la Núria');
  c.photo(c.at(2024, 2, 22, 23, 1), 'Pau', '');
  return c;
}

/** Writes the showcase ZIPs into `<root>/showcase/`. */
export function writeShowcase(root) {
  const dir = path.join(root, 'showcase');
  fs.mkdirSync(dir, { recursive: true });
  const t = (y, m, d) => Date.UTC(y, m - 1, d, 12, 0);
  mama().zip(dir, 'Mama', [[t(2014, 5, 4), 'Els missatges i les trucades estan xifrats d\'extrem a extrem. Ningú fora d\'aquest xat, ni tan sols WhatsApp, no pot llegir-los ni escoltar-los.']]);
  avi().zip(dir, 'Avi Josep');
  laia().zip(dir, 'Laia');
  marc().zip(dir, 'Marc');
  familia().zip(dir, 'Família Puig');
  sopars().zip(dir, 'Sopars dels dijous');
  return dir;
}
