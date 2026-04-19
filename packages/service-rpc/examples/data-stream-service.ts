/**
 * Example Data Stream Service
 *
 * Demonstrates async generator streaming for real-time data
 */

export interface DataPoint {
  timestamp: number;
  value: number;
  label: string;
}

export interface DataStreamService {
  generateTimeSeries(count: number, interval: number): AsyncGenerator<DataPoint, void, unknown>;

  transformValues(
    input: AsyncIterable<number>,
    multiplier: number,
  ): AsyncGenerator<number, void, unknown>;

  filterData(
    input: AsyncIterable<DataPoint>,
    minValue: number,
  ): AsyncGenerator<DataPoint, void, unknown>;
}

export const dataStreamService: DataStreamService = {
  async *generateTimeSeries(
    count: number = 10,
    interval: number = 100,
  ): AsyncGenerator<DataPoint, void, unknown> {
    for (let i = 0; i < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, interval));

      yield {
        timestamp: Date.now(),
        value: Math.random() * 100,
        label: `Point ${i + 1}`,
      };
    }
  },

  async *transformValues(
    input: AsyncIterable<number>,
    multiplier: number = 2,
  ): AsyncGenerator<number, void, unknown> {
    for await (const value of input) {
      yield value * multiplier;
    }
  },

  async *filterData(
    input: AsyncIterable<DataPoint>,
    minValue: number = 50,
  ): AsyncGenerator<DataPoint, void, unknown> {
    for await (const point of input) {
      if (point.value >= minValue) {
        yield point;
      }
    }
  },
};
