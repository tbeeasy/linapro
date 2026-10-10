import type { Component } from 'vue';
import type { Router, RouteRecordRaw } from 'vue-router';

interface RouteMeta {
  /**
   * 激活图标（菜单/tab）
   */
  activeIcon?: string;
  /**
   * 当前激活的菜单，有时候不想激活现有菜单，需要激活父级菜单时使用
   */
  activePath?: string;
  /**
   * 是否固定标签页
   * @default false
   */
  affixTab?: boolean;
  /**
   * 固定标签页的顺序
   * @default 0
   */
  affixTabOrder?: number;
  /**
   * 需要特定的角色标识才可以访问
   * @default []
   */
  authority?: string[];
  /**
   * 徽标
   */
  badge?: string;
  /**
   * 徽标类型
   */
  badgeType?: 'dot' | 'normal';
  /**
   * 徽标颜色
   */
  badgeVariants?:
    | 'default'
    | 'destructive'
    | 'primary'
    | 'success'
    | 'warning'
    | string;
  /**
   * 路由对应dom是否缓存起来
   */
  domCached?: boolean;
  /**
   * 是否属于员工端 region（平行认证链）。
   * 由 setupEmpGuard 统一守卫：region 内除 empPublic 页外，无员工 JWT 一律重定向到 empLoginPath。
   * 区域根路由声明一次即可，子路由沿 vue-router meta 合并自动继承。
   * @default false
   */
  empRegion?: boolean;
  /**
   * 员工端区域内的公开页（如 login），无需员工 JWT 即可访问。
   * 仅在 empRegion=true 的子树内生效。
   * @default false
   */
  empPublic?: boolean;
  /**
   * 员工端区域未认证时的重定向目标（登录页路径）。
   * 在该 region 根路由上声明一次，子路由继承；缺失时守卫不重定向。
   */
  empLoginPath?: string;
  /**
   * 员工端极简布局顶栏标题的 i18n 键。
   * 缺省回退平台级 page.empLayout.title。
   */
  empLayoutTitle?: string;
  /**
   * 路由的完整路径作为key（默认true）
   */
  fullPathKey?: boolean;
  /**
   * 当前路由的子级在菜单中不展现
   * @default false
   */
  hideChildrenInMenu?: boolean;
  /**
   * 当前路由在面包屑中不展现
   * @default false
   */
  hideInBreadcrumb?: boolean;
  /**
   * 当前路由在菜单中不展现
   * @default false
   */
  hideInMenu?: boolean;
  /**
   * 当前路由在标签页不展现
   * @default false
   */
  hideInTab?: boolean;
  /**
   * 图标（菜单/tab）
   */
  icon?: Component | string;
  /**
   * iframe 地址
   */
  iframeSrc?: string;
  /**
   * 路由标题运行时 i18n 键
   */
  i18nKey?: string;
  /**
   * 多租户访问模式。
   * disabled: 仅单租户模式展示
   * platform: 多租户平台上下文展示
   * tenant: 多租户租户上下文展示
   * enabled: 任意多租户上下文展示
   */
  tenantAccessMode?: 'disabled' | 'enabled' | 'platform' | 'tenant';
  /**
   * 忽略权限，直接可以访问
   * @default false
   */
  ignoreAccess?: boolean;
  /**
   * 开启KeepAlive缓存
   */
  keepAlive?: boolean;
  /**
   * 外链-跳转路径
   */
  link?: string;
  /**
   * 路由是否已经加载过
   */
  loaded?: boolean;
  /**
   * 标签页最大打开数量
   * @default -1
   */
  maxNumOfOpenTab?: number;
  /**
   * 菜单可以看到，但是访问会被重定向到403
   */
  menuVisibleWithForbidden?: boolean;
  /**
   * 不使用基础布局（仅在顶级生效）
   */
  noBasicLayout?: boolean;
  /**
   * 在新窗口打开
   */
  openInNewWindow?: boolean;
  /**
   * 用于路由->菜单排序
   */
  order?: number;
  /**
   * 菜单所携带的参数
   */
  query?: Recordable;
  /**
   * 标题名称
   */
  title: string;
}

// 定义递归类型以将 RouteRecordRaw 的 component 属性更改为 string
type RouteRecordStringComponent<T = string> = Omit<
  RouteRecordRaw,
  'children' | 'component'
> & {
  children?: RouteRecordStringComponent<T>[];
  component: T;
};

type ComponentRecordType = Record<string, () => Promise<Component>>;

interface GenerateMenuAndRoutesOptions {
  fetchMenuListAsync?: () => Promise<RouteRecordStringComponent[]>;
  forbiddenComponent?: RouteRecordRaw['component'];
  layoutMap?: ComponentRecordType;
  pageMap?: ComponentRecordType;
  roles?: string[];
  router: Router;
  routes: RouteRecordRaw[];
}

export type {
  ComponentRecordType,
  GenerateMenuAndRoutesOptions,
  RouteMeta,
  RouteRecordRaw,
  RouteRecordStringComponent,
};
