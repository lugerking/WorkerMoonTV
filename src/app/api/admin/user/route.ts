/* eslint-disable @typescript-eslint/no-explicit-any,no-console,@typescript-eslint/no-non-null-assertion */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { setSiteConfig } from '@/lib/kv.db';
import { getAllUsers, getOwnerName, updateUserMeta } from '@/lib/users';

export const runtime = 'nodejs';

// 支持的操作类型
const ACTIONS = [
  'add',
  'ban',
  'unban',
  'setAdmin',
  'cancelAdmin',
  'setAllowRegister',
  'changePassword',
  'deleteUser',
] as const;

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储进行管理员配置',
      },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();

    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const username = authInfo.username;

    const {
      targetUsername, // 目标用户名
      targetPassword, // 目标用户密码（仅在添加用户 / 修改密码时需要）
      allowRegister,
      action,
    } = body as {
      targetUsername?: string;
      targetPassword?: string;
      allowRegister?: boolean;
      action?: (typeof ACTIONS)[number];
    };

    if (!action || !ACTIONS.includes(action)) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    if (action !== 'setAllowRegister' && !targetUsername) {
      return NextResponse.json({ error: '缺少目标用户名' }, { status: 400 });
    }

    if (
      action !== 'setAllowRegister' &&
      action !== 'changePassword' &&
      action !== 'deleteUser' &&
      username === targetUsername
    ) {
      return NextResponse.json(
        { error: '无法对自己进行此操作' },
        { status: 400 }
      );
    }

    // 「允许注册」是站点级设置，存于站点配置分片
    if (action === 'setAllowRegister') {
      if (typeof allowRegister !== 'boolean') {
        return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
      }
      // 权限校验：站长或管理员
      const operator = await getAllUsers().then((list) =>
        list.find((u) => u.username === username)
      );
      if (!operator || (operator.role !== 'owner' && operator.role !== 'admin')) {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }

      const adminConfig = await getConfig();
      adminConfig.SiteConfig.AllowRegister = allowRegister;
      await setSiteConfig(adminConfig.SiteConfig);

      return NextResponse.json(
        { ok: true },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // 用户列表（含角色与封禁状态）直接来自用户数据存储
    const users = await getAllUsers();
    const ownerName = getOwnerName();

    // 判定操作者角色
    let operatorRole: 'owner' | 'admin';
    if (username === ownerName) {
      operatorRole = 'owner';
    } else {
      const operator = users.find((u) => u.username === username);
      if (!operator || operator.role !== 'admin') {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }
      operatorRole = 'admin';
    }

    // 查找目标用户条目
    const targetEntry = users.find((u) => u.username === targetUsername);

    if (
      targetEntry &&
      targetEntry.role === 'owner' &&
      action !== 'changePassword'
    ) {
      return NextResponse.json({ error: '无法操作站长' }, { status: 400 });
    }

    // 权限校验逻辑
    const isTargetAdmin = targetEntry?.role === 'admin';

    switch (action) {
      case 'add': {
        if (targetEntry) {
          return NextResponse.json({ error: '用户已存在' }, { status: 400 });
        }
        if (!targetPassword) {
          return NextResponse.json(
            { error: '缺少目标用户密码' },
            { status: 400 }
          );
        }
        await db.registerUser(targetUsername!, targetPassword);
        break;
      }
      case 'ban': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 }
          );
        }
        if (isTargetAdmin && operatorRole !== 'owner') {
          return NextResponse.json(
            { error: '仅站长可封禁管理员' },
            { status: 401 }
          );
        }
        await updateUserMeta(targetUsername!, { banned: true });
        break;
      }
      case 'unban': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 }
          );
        }
        if (isTargetAdmin && operatorRole !== 'owner') {
          return NextResponse.json(
            { error: '仅站长可操作管理员' },
            { status: 401 }
          );
        }
        await updateUserMeta(targetUsername!, { banned: false });
        break;
      }
      case 'setAdmin': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 }
          );
        }
        if (targetEntry.role === 'admin') {
          return NextResponse.json(
            { error: '该用户已是管理员' },
            { status: 400 }
          );
        }
        if (operatorRole !== 'owner') {
          return NextResponse.json(
            { error: '仅站长可设置管理员' },
            { status: 401 }
          );
        }
        await updateUserMeta(targetUsername!, { role: 'admin' });
        break;
      }
      case 'cancelAdmin': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 }
          );
        }
        if (targetEntry.role !== 'admin') {
          return NextResponse.json(
            { error: '目标用户不是管理员' },
            { status: 400 }
          );
        }
        if (operatorRole !== 'owner') {
          return NextResponse.json(
            { error: '仅站长可取消管理员' },
            { status: 401 }
          );
        }
        await updateUserMeta(targetUsername!, { role: 'user' });
        break;
      }
      case 'changePassword': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 }
          );
        }
        if (!targetPassword) {
          return NextResponse.json({ error: '缺少新密码' }, { status: 400 });
        }

        // 权限检查：不允许修改站长密码
        if (targetEntry.role === 'owner') {
          return NextResponse.json(
            { error: '无法修改站长密码' },
            { status: 401 }
          );
        }

        if (
          isTargetAdmin &&
          operatorRole !== 'owner' &&
          username !== targetUsername
        ) {
          return NextResponse.json(
            { error: '仅站长可修改其他管理员密码' },
            { status: 401 }
          );
        }

        await db.changePassword(targetUsername!, targetPassword);
        break;
      }
      case 'deleteUser': {
        if (!targetEntry) {
          return NextResponse.json(
            { error: '目标用户不存在' },
            { status: 404 }
          );
        }

        // 权限检查：站长可删除所有用户（除了自己），管理员可删除普通用户
        if (username === targetUsername) {
          return NextResponse.json({ error: '不能删除自己' }, { status: 400 });
        }

        if (isTargetAdmin && operatorRole !== 'owner') {
          return NextResponse.json(
            { error: '仅站长可删除管理员' },
            { status: 401 }
          );
        }

        // 删除用户（含密码、角色/封禁、播放记录、收藏、搜索历史）
        await db.deleteUser(targetUsername!);
        break;
      }
      default:
        return NextResponse.json({ error: '未知操作' }, { status: 400 });
    }

    return NextResponse.json(
      { ok: true },
      {
        headers: {
          'Cache-Control': 'no-store', // 管理员配置不缓存
        },
      }
    );
  } catch (error) {
    console.error('用户管理操作失败:', error);
    return NextResponse.json(
      {
        error: '用户管理操作失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
