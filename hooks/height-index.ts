/**
 * Where each row of a long list sits, when only some rows have been measured.
 *
 * A row's height is what was measured, else `estimate`. `offsetOf(i)` is the sum of the heights
 * before it, kept in a Fenwick tree of (measured - estimate), so one measurement and one lookup
 * both cost O(log n) however many rows there are: 200,000 rows need 2 typed arrays (about 2 MB)
 * and no per-row objects.
 */
export class HeightIndex {
  readonly count: number;
  readonly estimate: number;
  private readonly heights: Float32Array; // 0 = not measured
  private readonly tree: Float64Array; // 1-based Fenwick over (height - estimate)

  constructor(count: number, estimate: number) {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer');
    if (!(estimate > 0)) throw new RangeError('estimate must be positive');
    this.count = count;
    this.estimate = estimate;
    this.heights = new Float32Array(count);
    this.tree = new Float64Array(count + 1);
  }

  isMeasured(i: number): boolean {
    return this.heights[i] > 0;
  }

  heightOf(i: number): number {
    return this.heights[i] > 0 ? this.heights[i] : this.estimate;
  }

  /** Records a measured height; returns how much the row changed (0 when nothing did). */
  measure(i: number, height: number): number {
    if (i < 0 || i >= this.count || !(height > 0)) return 0;
    const delta = height - this.heightOf(i);
    if (Math.abs(delta) < 0.01) return 0;
    this.heights[i] = height;
    for (let k = i + 1; k <= this.count; k += k & -k) this.tree[k] += delta;
    return delta;
  }

  /** Top edge of row `i` (`i === count` gives the total). */
  offsetOf(i: number): number {
    let sum = 0;
    for (let k = Math.min(i, this.count); k > 0; k -= k & -k) sum += this.tree[k];
    return Math.min(i, this.count) * this.estimate + sum;
  }

  total(): number {
    return this.offsetOf(this.count);
  }

  /** The row that contains vertical position `y`, clamped to the first and last row; -1 when empty. */
  indexAt(y: number): number {
    if (this.count === 0) return -1;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsetOf(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Rows to render for a viewport: from the row `overscan` px above `top` to the row `overscan`
   * px below the bottom, never more than `max` rows (so the DOM stays bounded whatever the heights).
   */
  rangeFor(top: number, viewport: number, overscan: number, max = 300): { start: number; end: number } {
    if (this.count === 0) return { start: 0, end: 0 };
    const start = this.indexAt(top - overscan);
    const limit = top + viewport + overscan;
    let end = start;
    let y = this.offsetOf(start);
    while (end < this.count && y < limit && end - start < max) y += this.heightOf(end++);
    return { start, end };
  }
}
