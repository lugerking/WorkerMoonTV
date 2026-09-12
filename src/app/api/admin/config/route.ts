/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { AdminConfigResult } from '@/lib/admin.types';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { getAllUsers, isAdmin } from '@/lib/users';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储进行管理员配置',
      },
      { status: 400 }
    );
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const username = authInfo.username;

  try {
    const config = await getConfig();
    // 用户列表来自用户数据存储（如 D1 的 users 表），不再冗余存放于配置中
    const users = await getAllUsers();

    const result: AdminConfigResult = {
      Role: 'owner',
      Config: config,
      Users: users,
    };

    if (username === process.env.USERNAME) {
      result.Role = 'owner';
    } else if (await isAdmin(username)) {
      result.Role = 'admin';
    } else {
      return NextResponse.json(
        { error: '你是管理员吗你就访问？' },
        { status: 401 }
      );
    }

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store', // 管理员配置不缓存
      },
    });
  } catch (error) {
    console.error('获取管理员配置失败:', error);
    return NextResponse.json(
      {
        error: '获取管理员配置失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
