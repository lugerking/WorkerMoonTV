/* eslint-disable @typescript-eslint/no-explicit-any, no-console, @typescript-eslint/no-non-null-assertion */

import { AdminConfig } from './admin.types';
import { getAdminConfig, setAdminConfig } from './kv.db';
import runtimeConfig from './runtime';

export interface ApiSite {
  key: string;
  api: string;
  name: string;
  detail?: string;
}

interface ConfigFileStruct {
  cache_time?: number;
  api_site: {
    [key: string]: ApiSite;
  };
  custom_category?: {
    name?: string;
    type: 'movie' | 'tv';
    query: string;
  }[];
}

export const API_CONFIG = {
  search: {
    path: '?ac=videolist&wd=',
    pagePath: '?ac=videolist&wd={query}&pg={page}',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  },
  detail: {
    path: '?ac=videolist&ids=',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  },
};

/** 图片缓存数量上限默认值（管理界面可调整，0 表示不限制） */
export const DEFAULT_IMAGE_CACHE_LIMIT = 500;

// 在模块加载时根据环境决定配置来源
let fileConfig: ConfigFileStruct;
let cachedConfig: AdminConfig;

async function initConfig() {
  if (cachedConfig) {
    return;
  }

  if (process.env.DOCKER_ENV === 'true') {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const _require = eval('require') as NodeRequire;
    const fs = _require('fs') as typeof import('fs');
    const path = _require('path') as typeof import('path');

    const configPath = path.join(process.cwd(), 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(raw) as ConfigFileStruct;
    console.log('load dynamic config success');
  } else {
    // 默认使用编译时生成的配置
    fileConfig = runtimeConfig as unknown as ConfigFileStruct;
  }
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType !== 'localstorage') {
    // 数据库存储，读取并补全管理员配置
    try {
      // 从 KV 读取管理员配置（配置已从 D1 迁移到 Workers KV）
      let adminConfig: AdminConfig | null = await getAdminConfig();

      // 从文件中获取源信息，用于补全源
      const apiSiteEntries = Object.entries(fileConfig.api_site);
      const customCategories = fileConfig.custom_category || [];

      if (adminConfig) {
        // 补全 SourceConfig
        const sourceConfigMap = new Map(
          (adminConfig.SourceConfig || []).map((s) => [s.key, s])
        );

        apiSiteEntries.forEach(([key, site]) => {
          sourceConfigMap.set(key, {
            key,
            name: site.name,
            api: site.api,
            detail: site.detail,
            from: 'config',
            disabled: false,
          });
        });

        // 将 Map 转换回数组
        adminConfig.SourceConfig = Array.from(sourceConfigMap.values());

        // 检查现有源是否在 fileConfig.api_site 中，如果不在则标记为 custom
        const apiSiteKeys = new Set(apiSiteEntries.map(([key]) => key));
        adminConfig.SourceConfig.forEach((source) => {
          if (!apiSiteKeys.has(source.key)) {
            source.from = 'custom';
          }
        });

        // 确保 CustomCategories 被初始化
        if (!adminConfig.CustomCategories) {
          adminConfig.CustomCategories = [];
        }

        // 补全 CustomCategories
        const customCategoriesMap = new Map(
          adminConfig.CustomCategories.map((c) => [c.query + c.type, c])
        );

        customCategories.forEach((category) => {
          customCategoriesMap.set(category.query + category.type, {
            name: category.name,
            type: category.type,
            query: category.query,
            from: 'config',
            disabled: false,
          });
        });

        // 检查现有 CustomCategories 是否在 fileConfig.custom_category 中，如果不在则标记为 custom
        const customCategoriesKeys = new Set(
          customCategories.map((c) => c.query + c.type)
        );
        customCategoriesMap.forEach((category) => {
          if (!customCategoriesKeys.has(category.query + category.type)) {
            category.from = 'custom';
          }
        });

        // 将 Map 转换回数组
        adminConfig.CustomCategories = Array.from(customCategoriesMap.values());

      } else {
        // 数据库中没有配置，创建新的管理员配置
        adminConfig = {
          SiteConfig: {
            SiteName: process.env.SITE_NAME || 'MoonTV',
            Announcement:
              process.env.ANNOUNCEMENT ||
              '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',
            SearchDownstreamMaxPage:
              Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 5,
            SiteInterfaceCacheTime: fileConfig.cache_time || 7200,
            ImageProxy: process.env.NEXT_PUBLIC_IMAGE_PROXY || '',
            DoubanProxy: process.env.NEXT_PUBLIC_DOUBAN_PROXY || '',
            DisableYellowFilter:
              process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true',
            AllowRegister: process.env.NEXT_PUBLIC_ENABLE_REGISTER === 'true',
            ImageCacheLimit: DEFAULT_IMAGE_CACHE_LIMIT,
          },
          SourceConfig: apiSiteEntries.map(([key, site]) => ({
            key,
            name: site.name,
            api: site.api,
            detail: site.detail,
            from: 'config',
            disabled: false,
          })),
          CustomCategories: customCategories.map((category) => ({
            name: category.name,
            type: category.type,
            query: category.query,
            from: 'config',
            disabled: false,
          })),
        };
      }

      // 写回 KV（更新/创建）
      await setAdminConfig(adminConfig);

      // 更新缓存
      cachedConfig = adminConfig;
    } catch (err) {
      console.error('加载管理员配置失败:', err);
    }
  } else {
    // 本地存储直接使用文件配置
    cachedConfig = {
      SiteConfig: {
        SiteName: process.env.SITE_NAME || 'MoonTV',
        Announcement:
          process.env.ANNOUNCEMENT ||
          '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',
        SearchDownstreamMaxPage:
          Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 5,
        SiteInterfaceCacheTime: fileConfig.cache_time || 7200,
        ImageProxy: process.env.NEXT_PUBLIC_IMAGE_PROXY || '',
        DoubanProxy: process.env.NEXT_PUBLIC_DOUBAN_PROXY || '',
        DisableYellowFilter:
          process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true',
        AllowRegister: process.env.NEXT_PUBLIC_ENABLE_REGISTER === 'true',
        ImageCacheLimit: DEFAULT_IMAGE_CACHE_LIMIT,
      },
      SourceConfig: Object.entries(fileConfig.api_site).map(([key, site]) => ({
        key,
        name: site.name,
        api: site.api,
        detail: site.detail,
        from: 'config',
        disabled: false,
      })),
      CustomCategories:
        fileConfig.custom_category?.map((category) => ({
          name: category.name,
          type: category.type,
          query: category.query,
          from: 'config',
          disabled: false,
        })) || [],
    } as AdminConfig;
  }
}

export async function getConfig(): Promise<AdminConfig> {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (process.env.DOCKER_ENV === 'true' || storageType === 'localstorage') {
    await initConfig();
    return cachedConfig;
  }
  // 非 docker 环境：从 KV 读取管理员配置
  const adminConfig: AdminConfig | null = await getAdminConfig();
  if (adminConfig) {
    // 确保基础结构存在
    if (!adminConfig.CustomCategories) {
      adminConfig.CustomCategories = [];
    }
    if (!adminConfig.SiteConfig) {
      adminConfig.SiteConfig = {} as any;
    }

    // 配置以「数据库」为准：环境变量仅作为「数据库中未设置时」的默认值
    const siteConfig = adminConfig.SiteConfig as any;
    if (!siteConfig.SiteName) {
      siteConfig.SiteName = process.env.SITE_NAME || 'MoonTV';
    }
    if (!siteConfig.Announcement) {
      siteConfig.Announcement =
        process.env.ANNOUNCEMENT ||
        '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。';
    }
    if (siteConfig.SearchDownstreamMaxPage == null) {
      siteConfig.SearchDownstreamMaxPage =
        Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 5;
    }
    if (siteConfig.SiteInterfaceCacheTime == null) {
      siteConfig.SiteInterfaceCacheTime = 7200;
    }
    if (siteConfig.ImageProxy == null) {
      siteConfig.ImageProxy = process.env.NEXT_PUBLIC_IMAGE_PROXY || '';
    }
    if (siteConfig.DoubanProxy == null) {
      siteConfig.DoubanProxy = process.env.NEXT_PUBLIC_DOUBAN_PROXY || '';
    }
    if (siteConfig.DisableYellowFilter == null) {
      siteConfig.DisableYellowFilter =
        process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true';
    }
    if (siteConfig.AllowRegister == null) {
      siteConfig.AllowRegister =
        process.env.NEXT_PUBLIC_ENABLE_REGISTER === 'true';
    }
    if (siteConfig.ImageCacheLimit == null) {
      siteConfig.ImageCacheLimit = DEFAULT_IMAGE_CACHE_LIMIT;
    }

    // 视频源：以数据库为准；config.json 仅补充数据库中尚不存在的源
    fileConfig = runtimeConfig as unknown as ConfigFileStruct;
    const apiSiteEntries = Object.entries(fileConfig.api_site);
    const sourceConfigMap = new Map(
      (adminConfig.SourceConfig || []).map((s) => [s.key, s])
    );

    apiSiteEntries.forEach(([key, site]) => {
      if (!sourceConfigMap.has(key)) {
        sourceConfigMap.set(key, {
          key,
          name: site.name,
          api: site.api,
          detail: site.detail,
          from: 'config',
          disabled: false,
        });
      }
    });

    // 将 Map 转换回数组
    adminConfig.SourceConfig = Array.from(sourceConfigMap.values());

    // 自定义分类：以数据库为准；config.json 仅补充数据库中尚不存在的分类
    const customCategories = fileConfig.custom_category || [];
    const customCategoriesMap = new Map(
      adminConfig.CustomCategories.map((c) => [`${c.query}:${c.type}`, c])
    );
    customCategories.forEach((category) => {
      const mapKey = `${category.query}:${category.type}`;
      if (!customCategoriesMap.has(mapKey)) {
        customCategoriesMap.set(mapKey, {
          name: category.name,
          type: category.type,
          query: category.query,
          from: 'config',
          disabled: false,
        });
      }
    });
    adminConfig.CustomCategories = Array.from(customCategoriesMap.values());

    cachedConfig = adminConfig;
  } else {
    // DB 无配置，执行一次初始化
    await initConfig();
  }
  return cachedConfig;
}

export async function resetConfig() {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  if (process.env.DOCKER_ENV === 'true') {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const _require = eval('require') as NodeRequire;
    const fs = _require('fs') as typeof import('fs');
    const path = _require('path') as typeof import('path');

    const configPath = path.join(process.cwd(), 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(raw) as ConfigFileStruct;
    console.log('load dynamic config success');
  } else {
    // 默认使用编译时生成的配置
    fileConfig = runtimeConfig as unknown as ConfigFileStruct;
  }

  const apiSiteEntries = Object.entries(fileConfig.api_site);
  const customCategories = fileConfig.custom_category || [];
  const adminConfig = {
    SiteConfig: {
      SiteName: process.env.SITE_NAME || 'MoonTV',
      Announcement:
        process.env.ANNOUNCEMENT ||
        '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',
      SearchDownstreamMaxPage:
        Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 5,
      SiteInterfaceCacheTime: fileConfig.cache_time || 7200,
      ImageProxy: process.env.NEXT_PUBLIC_IMAGE_PROXY || '',
      DoubanProxy: process.env.NEXT_PUBLIC_DOUBAN_PROXY || '',
      DisableYellowFilter:
        process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true',
      AllowRegister: process.env.NEXT_PUBLIC_ENABLE_REGISTER === 'true',
      ImageCacheLimit: DEFAULT_IMAGE_CACHE_LIMIT,
    },
    SourceConfig: apiSiteEntries.map(([key, site]) => ({
      key,
      name: site.name,
      api: site.api,
      detail: site.detail,
      from: 'config',
      disabled: false,
    })),
    CustomCategories:
      storageType === 'redis'
        ? customCategories?.map((category) => ({
            name: category.name,
            type: category.type,
            query: category.query,
            from: 'config',
            disabled: false,
          })) || []
        : [],
  } as AdminConfig;

  await setAdminConfig(adminConfig);
  if (cachedConfig == null) {
    // serverless 环境，直接使用 adminConfig
    cachedConfig = adminConfig;
  }
  cachedConfig.SiteConfig = adminConfig.SiteConfig;
  cachedConfig.SourceConfig = adminConfig.SourceConfig;
  cachedConfig.CustomCategories = adminConfig.CustomCategories;
}

export async function getCacheTime(): Promise<number> {
  const config = await getConfig();
  return config.SiteConfig.SiteInterfaceCacheTime || 7200;
}

export async function getAvailableApiSites(): Promise<ApiSite[]> {
  const config = await getConfig();
  return config.SourceConfig.filter((s) => !s.disabled).map((s) => ({
    key: s.key,
    name: s.name,
    api: s.api,
    detail: s.detail,
  }));
}
