/**
 * Example User Management Service
 *
 * Demonstrates a more complex service with CRUD operations
 */

export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user" | "guest";
  createdAt: number;
}

export interface CreateUserInput {
  name: string;
  email: string;
  role?: "admin" | "user" | "guest";
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  role?: "admin" | "user" | "guest";
}

export interface UserManagementService {
  createUser(input: CreateUserInput): Promise<User>;
  getUser(id: string): Promise<User | null>;
  updateUser(id: string, input: UpdateUserInput): Promise<User>;
  deleteUser(id: string): Promise<boolean>;
  listUsers(limit?: number, offset?: number): Promise<User[]>;
  streamUsers(): AsyncGenerator<User, void, unknown>;
}

// In-memory storage for demo
const users = new Map<string, User>();
let userId = 1;

export const userManagementService: UserManagementService = {
  async createUser(input: CreateUserInput): Promise<User> {
    const user: User = {
      id: `user-${userId++}`,
      name: input.name,
      email: input.email,
      role: input.role || "user",
      createdAt: Date.now(),
    };

    users.set(user.id, user);
    return user;
  },

  async getUser(id: string): Promise<User | null> {
    return users.get(id) || null;
  },

  async updateUser(id: string, input: UpdateUserInput): Promise<User> {
    const user = users.get(id);
    if (!user) {
      throw new Error(`User ${id} not found`);
    }

    const updated: User = {
      ...user,
      ...(input.name && { name: input.name }),
      ...(input.email && { email: input.email }),
      ...(input.role && { role: input.role }),
    };

    users.set(id, updated);
    return updated;
  },

  async deleteUser(id: string): Promise<boolean> {
    return users.delete(id);
  },

  async listUsers(limit: number = 10, offset: number = 0): Promise<User[]> {
    const allUsers = Array.from(users.values());
    return allUsers.slice(offset, offset + limit);
  },

  async *streamUsers(): AsyncGenerator<User, void, unknown> {
    for (const user of users.values()) {
      yield user;
      // Simulate async streaming with small delay
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  },
};
