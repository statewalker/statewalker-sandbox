/**
 * Example Calculator Service
 *
 * Demonstrates a simple RPC service with basic math operations
 */

export interface CalculatorService {
  add(a: number, b: number): Promise<number>;
  subtract(a: number, b: number): Promise<number>;
  multiply(a: number, b: number): Promise<number>;
  divide(a: number, b: number): Promise<number>;
  power(base: number, exponent: number): Promise<number>;
}

export const calculatorService: CalculatorService = {
  async add(a: number, b: number): Promise<number> {
    return a + b;
  },

  async subtract(a: number, b: number): Promise<number> {
    return a - b;
  },

  async multiply(a: number, b: number): Promise<number> {
    return a * b;
  },

  async divide(a: number, b: number): Promise<number> {
    if (b === 0) {
      throw new Error("Division by zero");
    }
    return a / b;
  },

  async power(base: number, exponent: number): Promise<number> {
    return base ** exponent;
  },
};
