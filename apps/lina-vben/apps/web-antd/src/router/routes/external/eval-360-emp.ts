import type { RouteRecordRaw } from 'vue-router';

// eval-360-emp.ts 员工端路由模块。
// 放在 routes/external/：启动即静态注册。员工无管理端会话，若放在 modules/（管理端登录后
// 才动态注册的 accessRoutes），无会话打开员工链接会落到 404 兜底并被管理端守卫转去管理端登录页。
// 全部 meta.ignoreAccess=true：绕过 admin setupAccessGuard（员工无 admin token）。
// hideInMenu/hideInTab/hideInBreadcrumb：不进 admin 侧栏与标签页。
// 实际登录态由 setupEmpGuard（guard.ts）按 meta 标记守卫——见下方 empRegion 说明。
//
// 平台级员工端 region 标记（由通用守卫/布局消费，非本插件专属）：
//   empRegion=true     声明本子树属员工平行认证链，交给 setupEmpGuard 守卫；
//   empLoginPath       未认证时的登录页路径；
//   empLayoutTitle     （可选）覆盖侧栏品牌标题 i18n 键；未声明则用平台默认 page.empLayout.title；
//   empMenu            子路由声明后进入员工端布局侧栏菜单（图标 meta.icon、排序 meta.order）；
//   empActiveMenu      非菜单页高亮的侧栏菜单路由 name。
// vue-router 会沿匹配链合并 meta：在区域根声明一次，子路由自动继承，
// 仅需覆写的页（如 login 的 empPublic）单独声明。
const routes: RouteRecordRaw[] = [
  {
    path: '/eval-360/emp',
    name: 'Eval360EmpRegion',
    component: () => import('#/layouts/emp.vue'),
    meta: {
      ignoreAccess: true,
      hideInBreadcrumb: true,
      hideInMenu: true,
      hideInTab: true,
      title: 'page.routes.eval360Emp.region',
      // 员工端 region 标记：由 setupEmpGuard 与 emp.vue 布局统一消费。
      empRegion: true,
      empLoginPath: '/eval-360/emp/login',
      empLayoutTitle: 'page.eval360Emp.layoutTitle',
    },
    redirect: '/eval-360/emp/dashboard',
    children: [
      {
        name: 'Eval360EmpLogin',
        path: 'login',
        component: () => import('#/views/eval-360/emp/login.vue'),
        meta: {
          ignoreAccess: true,
          hideInMenu: true,
          title: 'page.routes.eval360Emp.login',
          // 登录页无需员工 JWT，声明公开页放行。
          empPublic: true,
        },
      },
      {
        name: 'Eval360EmpDashboard',
        path: 'dashboard',
        component: () => import('#/views/eval-360/emp/dashboard.vue'),
        meta: {
          ignoreAccess: true,
          hideInMenu: true,
          title: 'page.routes.eval360Emp.dashboard',
          empMenu: true,
          icon: 'lucide:layout-grid',
          order: 1,
        },
      },
      {
        // 「我的评估」沿用 todo 路径：飞书卡片链接（todo_h5_url）指向此处，改路径会使已发卡片失效。
        name: 'Eval360EmpTodo',
        path: 'todo',
        component: () => import('#/views/eval-360/emp/todo.vue'),
        meta: {
          ignoreAccess: true,
          hideInMenu: true,
          title: 'page.routes.eval360Emp.todo',
          empMenu: true,
          icon: 'lucide:clipboard-check',
          order: 2,
        },
      },
      {
        name: 'Eval360EmpAnswer',
        path: 'answer',
        component: () => import('#/views/eval-360/emp/answer.vue'),
        meta: {
          ignoreAccess: true,
          hideInMenu: true,
          title: 'page.routes.eval360Emp.answer',
          empActiveMenu: 'Eval360EmpTodo',
        },
      },
      {
        name: 'Eval360EmpResult',
        path: 'result',
        component: () => import('#/views/eval-360/emp/result.vue'),
        meta: {
          ignoreAccess: true,
          hideInMenu: true,
          title: 'page.routes.eval360Emp.result',
          empActiveMenu: 'Eval360EmpTodo',
        },
      },
    ],
  },
];

export default routes;
