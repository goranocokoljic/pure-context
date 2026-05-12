export interface UserModel {
  id: string;
  name: string;
  email: string;
}

export type UserId = string;

export const DEFAULT_TIMEOUT = 5000;

export function createModel(data: Partial<UserModel>): UserModel {
  return { id: '', name: '', email: '', ...data };
}

export async function saveModel(model: UserModel): Promise<boolean> {
  return true;
}
