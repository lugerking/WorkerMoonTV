/* eslint-disable no-console */

'use client';

const CURRENT_VERSION = '20250804231933';

// 版本检查结果枚举
export enum UpdateStatus {
  HAS_UPDATE = 'has_update', // 有新版本
  NO_UPDATE = 'no_update', // 无新版本
  FETCH_FAILED = 'fetch_failed', // 获取失败
}

// 远程版本检查URL配置
const VERSION_CHECK_URLS = [
  'https://ghfast.top/raw.githubusercontent.com/senshinya/MoonTV/main/VERSION.txt',
  'https://raw.githubusercontent.com/senshinya/MoonTV/main/VERSION.txt',
];

// 版本检查失败后的冷却时间：24 小时内不再重复发起外网请求
const CHECK_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CHECK_FAILURE_KEY = 'moontv-version-check-failed-at';

function isFailureCoolingDown(): boolean {
  try {
    const last = Number(sessionStorage.getItem(CHECK_FAILURE_KEY) || '0');
    return last > 0 && Date.now() - last < CHECK_FAILURE_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markFailure(): void {
  try {
    sessionStorage.setItem(CHECK_FAILURE_KEY, String(Date.now()));
  } catch {
    // 存储不可用时忽略，下次仍会尝试请求
  }
}

/**
 * 检查是否有新版本可用
 * @returns Promise<UpdateStatus> - 返回版本检查状态
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  // 上游版本文件不可达时（如网络受限），24 小时内跳过重复请求，避免控制台 404 噪音
  if (isFailureCoolingDown()) {
    return UpdateStatus.FETCH_FAILED;
  }
  try {
    // 尝试从主要URL获取版本信息
    const primaryVersion = await fetchVersionFromUrl(VERSION_CHECK_URLS[0]);
    if (primaryVersion) {
      return compareVersions(primaryVersion);
    }

    // 如果主要URL失败，尝试备用URL
    const backupVersion = await fetchVersionFromUrl(VERSION_CHECK_URLS[1]);
    if (backupVersion) {
      return compareVersions(backupVersion);
    }

    // 如果两个URL都失败，进入冷却期并返回获取失败状态
    markFailure();
    return UpdateStatus.FETCH_FAILED;
  } catch (error) {
    console.error('版本检查失败:', error);
    markFailure();
    return UpdateStatus.FETCH_FAILED;
  }
}

/**
 * 从指定URL获取版本信息
 * @param url - 版本信息URL
 * @returns Promise<string | null> - 版本字符串或null
 */
async function fetchVersionFromUrl(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const version = await response.text();
    return version.trim();
  } catch (error) {
    console.warn(`从 ${url} 获取版本信息失败:`, error);
    return null;
  }
}

/**
 * 比较版本号
 * @param remoteVersion - 远程版本号
 * @returns UpdateStatus - 返回版本比较结果
 */
function compareVersions(remoteVersion: string): UpdateStatus {
  try {
    // 将版本号转换为数字进行比较
    const current = parseInt(CURRENT_VERSION, 10);
    const remote = parseInt(remoteVersion, 10);

    return remote > current ? UpdateStatus.HAS_UPDATE : UpdateStatus.NO_UPDATE;
  } catch (error) {
    console.error('版本比较失败:', error);
    return UpdateStatus.FETCH_FAILED;
  }
}

// 导出当前版本号供其他地方使用
export { CURRENT_VERSION };
