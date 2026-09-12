/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

import { getStorage } from './db';
import { UserInfo, UserRole } from './types';

/**
 * 用户数据访问辅助层。
 *
 * 用户（用户名 / 密码 / 角色 / 封禁）的**唯一数据源是存储层**：
 * - D1：`users` 表（`username` / `password` / `role` / `banned`）
 * - Redis、Upstash：`u:<username>:pwd` + `u:<username>:role` + `u:<username>:banned`
 *
 * 历史上角色与封禁状态冗余存放在管理员配置（KV `admin_config:users`）中，
 * 与用户表重复且可能不一致，现已合并到用户表。
 *
 * 站长（owner）由环境变量 `USERNAME` 决定，是唯一的 owner：
 * 即便用户表中该行不存在（站长用环境变量密码登录），也会补一条 owner 记录。
 */

/** 站长用户名 */
export function getOwnerName(): string {
  return process.env.USERNAME || '';
}

/**
 * 读取全部用户（含角色与封禁状态），并把站长归一化：
 * - 环境变量指定的账号角色恒为 `owner`；
 * - 其他账号即便存储中写着 `owner` 也降级为 `user`。
 */
export async function getAllUsers(): Promise<UserInfo[]> {
  const storage = getStorage();
  let raw: UserInfo[] = [];
  try {
    if (storage && typeof (storage as any).getAllUsers === 'function') {
      raw = await (storage as any).getAllUsers();
    }
  } catch (err) {
    console.error('获取用户列表失败:', err);
  }

  const owner = getOwnerName();
  const seen = new Set<string>();
  const users: UserInfo[] = [];

  for (const item of raw || []) {
    const username = item?.username;
    if (!username || seen.has(username)) continue;
    seen.add(username);
    users.push({
      username,
      role:
        username === owner
          ? 'owner'
          : item.role === 'owner'
            ? 'user'
            : item.role || 'user',
      banned: Boolean(item.banned),
    });
  }

  // 站长可能尚未在存储中注册（用环境变量密码登录），补一条
  if (owner && !seen.has(owner)) {
    users.unshift({ username: owner, role: 'owner', banned: false });
  }

  return users;
}

/** 查询单个用户（含站长归一化）；不存在返回 null。 */
export async function findUser(username: string): Promise<UserInfo | null> {
  const users = await getAllUsers();
  return users.find((u) => u.username === username) || null;
}

/** 是否具备管理员权限（站长或管理员） */
export async function isAdmin(username: string): Promise<boolean> {
  const user = await findUser(username);
  return !!user && (user.role === 'admin' || user.role === 'owner');
}

/** 更新用户角色 / 封禁状态（写入存储层）。 */
export async function updateUserMeta(
  username: string,
  meta: { role?: UserRole; banned?: boolean }
): Promise<void> {
  const storage = getStorage();
  if (storage && typeof (storage as any).updateUserMeta === 'function') {
    await (storage as any).updateUserMeta(username, meta);
  }
}
