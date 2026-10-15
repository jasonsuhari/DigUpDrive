import { DIMENSION } from "./model.js";
import { words, terms as queryTerms, isLookup, kindHints, snippet, excerpt } from "./text.js";
import { eachSegment, allItems, getSegments } from "./store.js";

const Z_GATE = 2.0;
const WORD_WEIGHT = 2.0;
const MIN_MODALITY_ROWS = 20;
const MIN_DEVIATION = 0.02;
const STRONG_RATIO = 0.5;
const MIN_PREFIX = 3;

export class Searcher {
  constructor() {
    this.items = new Map();
    this.segments = new Map();
    this.postings = new Map();
    this.capacity = 0;
    this.rows = 0;
    this.matrix = new Float32Array(0);
    this.rowSegment = [];
    this.rowModality = [];
  }

  async load() {
    for (const item of await allItems()) this.items.set(item.id, item);
    await eachSegment((segment) => this.addSegment(segment));
    return this;
  }

  setItem(item) {
    this.items.set(item.id, item);
  }

  removeItem(id, segmentIds) {
    this.items.delete(id);
    for (const segmentId of segmentIds) this.removeSegment(segmentId);
  }

  removeSegment(id) {
    const segment = this.segments.get(id);
    if (!segment) return;
    if (segment.row !== undefined) this.rowSegment[segment.row] = -1;
    this.segments.delete(id);
  }

  addSegment({ id, item, kind, modality, loc, label, text, vec }) {
    const segment = { item, kind, modality, loc, label };
    if (vec) {
      this.grow(this.rows + 1);
      this.matrix.set(vec, this.rows * DIMENSION);
      this.rowSegment[this.rows] = id;
      this.rowModality[this.rows] = modality;
      segment.row = this.rows++;
    }
    this.segments.set(id, segment);
    if (text) {
      for (const word of new Set(words(text))) {
        let posting = this.postings.get(word);
        if (!posting) this.postings.set(word, (posting = []));
        posting.push(id);
      }
    }
  }

  grow(rows) {
    if (rows <= this.capacity) return;
    this.capacity = Math.max(1024, this.capacity * 2, rows);
    const matrix = new Float32Array(this.capacity * DIMENSION);
    matrix.set(this.matrix.subarray(0, this.rows * DIMENSION));
    this.matrix = matrix;
  }

  get vectorCount() {
    return this.rowSegment.filter((id) => id !== -1).length;
  }

  scores(query) {
    const scores = new Float32Array(this.rows);
    const { matrix } = this;
    for (let row = 0; row < this.rows; row++) {
      let sum = 0;
      const base = row * DIMENSION;
      for (let i = 0; i < DIMENSION; i++) sum += matrix[base + i] * query[i];
      scores[row] = sum;
    }
    return scores;
  }

  meaning(scores) {
    const live = [];
    for (let row = 0; row < this.rows; row++) if (this.rowSegment[row] !== -1) live.push(row);
    const sum = {};
    const count = {};
    for (const row of live) {
      const modality = this.rowModality[row];
      sum[modality] = (sum[modality] ?? 0) + scores[row];
      count[modality] = (count[modality] ?? 0) + 1;
    }
    const all = Object.values(sum).reduce((a, b) => a + b, 0) / Math.max(live.length, 1);
    const means = Object.fromEntries(
      Object.keys(sum).map((modality) => [modality, count[modality] >= MIN_MODALITY_ROWS ? sum[modality] / count[modality] : all]),
    );
    const centered = new Float64Array(this.rows);
    let total = 0;
    for (const row of live) total += centered[row] = scores[row] - means[this.rowModality[row]];
    const mean = total / Math.max(live.length, 1);
    let squares = 0;
    for (const row of live) squares += (centered[row] - mean) ** 2;
    const deviation = Math.max(Math.sqrt(squares / Math.max(live.length, 1)), MIN_DEVIATION);
    return { z: (row) => (centered[row] - mean) / deviation, live };
  }

  matching(term, prefix) {
    if (!prefix && this.postings.has(term)) return this.postings.get(term);
    if (!prefix && term.length < MIN_PREFIX) return [];
    const out = [];
    for (const [word, posting] of this.postings) if (word.startsWith(term)) out.push(...posting);
    return out;
  }

  async search(text, queryVector, { kinds = null, limit = 30, prefixLast = false } = {}) {
    const allowed = (itemId) => {
      const item = this.items.get(itemId);
      return item && (!kinds || kinds.includes(item.kind));
    };

    const best = new Map();
    if (queryVector && this.rows) {
      const scores = this.scores(queryVector);
      const { z, live } = this.meaning(scores);
      for (const row of live) {
        const segment = this.segments.get(this.rowSegment[row]);
        if (!segment || !allowed(segment.item)) continue;
        const value = z(row);
        if (value > (best.get(segment.item)?.z ?? -Infinity)) {
          best.set(segment.item, { z: value, cosine: scores[row], segment: this.rowSegment[row] });
        }
      }
    }

    const terms = queryTerms(text);
    const coverage = new Map();
    const keywordSegment = new Map();
    const matchedTerms = new Map();
    terms.forEach((term, index) => {
      const seen = new Set();
      for (const segmentId of this.matching(term, prefixLast && index === terms.length - 1)) {
        const segment = this.segments.get(segmentId);
        if (!segment || !allowed(segment.item)) continue;
        matchedTerms.set(segmentId, (matchedTerms.get(segmentId) ?? 0) + 1);
        if (!seen.has(segment.item)) {
          seen.add(segment.item);
          coverage.set(segment.item, (coverage.get(segment.item) ?? 0) + 1 / terms.length);
        }
      }
    });
    for (const [segmentId, count] of matchedTerms) {
      const { item, kind } = this.segments.get(segmentId);
      const current = keywordSegment.get(item);
      const strength = count + (kind === "name" ? 0.5 : 0);
      if (!current || strength > current.strength) keywordSegment.set(item, { segment: segmentId, strength });
    }

    const lookup = isLookup(terms);
    const [meaningWeight, wordsWeight] = lookup ? [0.5, WORD_WEIGHT * 2] : [1, WORD_WEIGHT];
    const hinted = kindHints(text);
    const candidates = new Set([...best].filter(([, value]) => value.z >= Z_GATE).map(([id]) => id));
    for (const [id, share] of coverage) if (share >= 0.5) candidates.add(id);

    const scored = [...candidates]
      .map((id) => {
        let score = meaningWeight * Math.max(best.get(id)?.z ?? 0, 0) + wordsWeight * (coverage.get(id) ?? 0) ** 1.5;
        if (hinted.has(this.items.get(id).kind)) score += 1;
        return { id, score };
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);

    const top = scored[0]?.score ?? 0;
    const hits = [];
    for (const { id, score } of scored) {
      const semantic = best.get(id);
      const keyword = keywordSegment.get(id);
      const useMeaning = semantic && (semantic.z >= Z_GATE || !keyword);
      const segmentId = useMeaning ? semantic.segment : keyword?.segment;
      const segment = this.segments.get(segmentId);
      hits.push({
        item: this.items.get(id),
        segmentId,
        segment: segment && { kind: segment.kind, loc: segment.loc, label: segment.label },
        score,
        z: semantic?.z ?? null,
        cosine: semantic?.cosine ?? null,
        words: coverage.get(id) ?? 0,
        strong: top > 0 && score >= top * STRONG_RATIO,
      });
    }
    await this.attachExcerpts(hits, terms);
    return hits;
  }

  async attachExcerpts(hits, terms) {
    const stored = await getSegments(hits.map((hit) => hit.segmentId).filter((id) => id !== undefined));
    const byId = new Map(stored.filter(Boolean).map((segment) => [segment.id, segment]));
    for (const hit of hits) {
      const segment = byId.get(hit.segmentId);
      if (!segment?.text || segment.kind === "name") continue;
      hit.excerpt = snippet(segment.text, terms) || excerpt(segment.text);
    }
  }
}
