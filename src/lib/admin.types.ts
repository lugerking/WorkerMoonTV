import { UserInfo } from './types';

export interface AdminConfig {
  SiteConfig: {
    SiteName: string;
    Announcement: string;
    SearchDownstreamMaxPage: number;
    SiteInterfaceCacheTime: number;
    ImageProxy: string;
    DoubanProxy: string;
    DisableYellowFilter: boolean;
    /** 是否允许新用户注册（原 UserConfig.AllowRegister，属站点级设置） */
    AllowRegister: boolean;
    /** 图片缓存数量上限：超过后按「近期访问频率」清理最不常用的图（0 表示不限制） */
    ImageCacheLimit: number;
  };
  SourceConfig: {
    key: string;
    name: string;
    api: string;
    detail?: string;
    from: 'config' | 'custom';
    disabled?: boolean;
  }[];
  CustomCategories: {
    name?: string;
    type: 'movie' | 'tv';
    query: string;
    from: 'config' | 'custom';
    disabled?: boolean;
  }[];
}

export interface AdminConfigResult {
  Role: 'owner' | 'admin';
  Config: AdminConfig;
  /** 用户列表（来自用户数据存储，如 D1 的 users 表），非配置内容 */
  Users: UserInfo[];
}
