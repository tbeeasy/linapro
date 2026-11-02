<script lang="ts" setup>
// emp.vue 员工端布局：左侧栏（品牌标题 + 菜单）+ 顶栏（当前页标题）+ 路由出口。
// 刻意不用 BasicLayout（员工无 admin 菜单/权限），与 admin 会话隔离。
// 本布局为平台级通用物，全部行为由路由 meta 驱动，不绑定具体业务插件，员工端（eval-360、考勤等）共用：
//   - 侧栏菜单 = region 根路由下声明 meta.empMenu 的子路由（图标 meta.icon、排序 meta.order）；
//   - 非菜单页用 meta.empActiveMenu 指定高亮的侧栏菜单路由 name；
//   - meta.empPublic 页（登录页）不渲染外壳，仅路由出口；
//   - 品牌标题取 meta.empLayoutTitle。
// 顶栏不展示员工身份与退出：员工端由飞书卡片免登进入，会话过期由请求拦截器统一处理。
// 侧栏左下角展示当前员工姓名：profile 仅内存驻留，刷新后为空时经 GET /emp/me 回填。
import type { RouteRecordRaw } from 'vue-router';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { IconifyIcon } from '@vben/icons';

import { empMeApi, toEmpProfile } from '#/api/emp/me';
import { $t } from '#/locales';
import { useEmpAuthStore } from '#/store/emp-auth';

const route = useRoute();
const router = useRouter();
const empStore = useEmpAuthStore();

// 窄屏（飞书移动端）默认收起侧栏，展开时以浮层覆盖内容。
const mobileWidth = 768;
const isMobile = ref(
  typeof window !== 'undefined' && window.innerWidth < mobileWidth,
);
const collapsed = ref(isMobile.value);

const isPublicPage = computed(() => Boolean(route.meta.empPublic));
const layoutTitle = computed(() =>
  $t(route.meta.empLayoutTitle || 'page.empLayout.title'),
);
const pageTitle = computed(() =>
  route.meta.title ? $t(route.meta.title) : '',
);

// 侧栏菜单：取 region 根路由（匹配链中声明 empRegion 的第一条）下声明 empMenu 的子路由。
const menus = computed(() => {
  const root = route.matched.find((r) => r.meta.empRegion);
  const children: RouteRecordRaw[] = root?.children ?? [];
  return children
    .filter((c) => c.meta?.empMenu && c.name)
    .toSorted((a, b) => (a.meta?.order ?? 0) - (b.meta?.order ?? 0))
    .map((c) => ({
      name: String(c.name),
      icon: c.meta?.icon as string | undefined,
      title: c.meta?.title ? $t(c.meta.title) : '',
    }));
});

const empName = computed(() => empStore.empProfile?.name ?? '');

// 有会话但 profile 未加载（刷新页面后）时回填；失败不阻塞页面，401 由请求拦截器统一处理。
let profileLoading = false;
async function loadProfile() {
  if (isPublicPage.value || !empStore.empToken || empStore.empProfile) return;
  if (profileLoading) return;
  profileLoading = true;
  try {
    empStore.setProfile(toEmpProfile(await empMeApi()));
  } catch {
    // 忽略：仅影响姓名展示
  } finally {
    profileLoading = false;
  }
}

watch([isPublicPage, () => empStore.empToken], () => void loadProfile(), {
  immediate: true,
});

const activeMenu = computed(
  () => route.meta.empActiveMenu || String(route.name ?? ''),
);

function go(name: string) {
  if (isMobile.value) collapsed.value = true;
  if (name !== route.name) void router.push({ name });
}

function onResize() {
  isMobile.value = window.innerWidth < mobileWidth;
}

onMounted(() => window.addEventListener('resize', onResize));
onBeforeUnmount(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <router-view v-if="isPublicPage" />
  <div v-else class="flex h-screen bg-[#f5f6f8]" data-testid="emp-layout">
    <!-- 窄屏展开侧栏时的遮罩 -->
    <div
      v-if="isMobile && !collapsed"
      class="fixed inset-0 z-30 bg-black/30"
      @click="collapsed = true"
    ></div>
    <aside
      v-show="!collapsed"
      class="z-40 flex w-[220px] shrink-0 flex-col border-r bg-white"
      :class="isMobile ? 'fixed inset-y-0 left-0 shadow-lg' : ''"
      data-testid="emp-layout-sider"
    >
      <div class="flex h-14 items-center gap-2 px-5">
        <span
          class="rounded-md bg-primary px-1.5 py-0.5 text-sm font-bold text-white"
        >
          360
        </span>
        <span class="truncate text-[15px] font-semibold">
          {{ layoutTitle }}
        </span>
      </div>
      <!-- 菜单项用 div 而非 a：antd 全局 a 样式（color/background）不在 CSS layer 内，会压过 tailwind 工具类。 -->
      <nav class="flex flex-1 flex-col gap-1 overflow-auto px-3 py-2">
        <div
          v-for="m in menus"
          :key="m.name"
          class="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
          :class="
            activeMenu === m.name
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-gray-700 hover:bg-gray-100'
          "
          :data-testid="`emp-menu-${m.name}`"
          @click="go(m.name)"
        >
          <IconifyIcon v-if="m.icon" :icon="m.icon" class="size-4" />
          <span>{{ m.title }}</span>
        </div>
      </nav>
      <div
        v-if="empName"
        class="flex items-center gap-2 border-t px-5 py-3"
        data-testid="emp-layout-user"
      >
        <span
          class="flex-center size-7 shrink-0 rounded-full bg-primary/10 text-xs font-medium text-primary"
        >
          {{ empName.slice(0, 1) }}
        </span>
        <span class="truncate text-sm text-gray-700" :title="empName">
          {{ empName }}
        </span>
      </div>
    </aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="flex h-14 shrink-0 items-center gap-3 border-b bg-white px-4"
      >
        <IconifyIcon
          icon="lucide:panel-left"
          class="size-5 cursor-pointer text-gray-600"
          data-testid="emp-layout-toggle"
          @click="collapsed = !collapsed"
        />
        <span class="text-sm">{{ pageTitle }}</span>
      </header>
      <main class="flex-1 overflow-auto">
        <router-view />
      </main>
    </div>
  </div>
</template>
