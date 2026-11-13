import { test, expect } from '../../../fixtures/auth';
import { ConfigPage } from '../../../pages/ConfigPage';

test.describe('TC007 参数值类型化编辑', () => {
  const selectName = `类型化下拉_${Date.now()}`;
  const selectKey = `test.typed.select.${Date.now()}`;

  test('TC-7a: 编辑忘记密码入口使用布尔组件并可保存', async ({
    adminPage,
  }) => {
    const configPage = new ConfigPage(adminPage);
    await configPage.goto();
    await configPage.openEditByKey('sys.auth.forgetPasswordEnabled');

    // Button-style radios: assert the visible wrapper, not the CSS-hidden input.
    await expect(configPage.booleanOption(/是|True/i)).toBeVisible();
    await expect(configPage.booleanOption(/否|False/i)).toBeVisible();

    // Toggle to the opposite of current selection by clicking both safely.
    await configPage.chooseBooleanValue('false');
    await configPage.confirmDialog();
    await expect(adminPage.getByText(/更新成功|Updated successfully|success/i).first()).toBeVisible({
      timeout: 5000,
    });

    // Restore enabled state for later suite stability.
    await configPage.openEditByKey('sys.auth.forgetPasswordEnabled');
    await configPage.chooseBooleanValue('true');
    await configPage.confirmDialog();
    await expect(adminPage.getByText(/更新成功|Updated successfully|success/i).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('TC-7b: 编辑登录框位置通过下拉选择合法布局值', async ({
    adminPage,
  }) => {
    const configPage = new ConfigPage(adminPage);
    await configPage.goto();
    await configPage.openEditByKey('sys.auth.loginPanelLayout');

    await configPage.selectDialogOption('参数键值', /左侧|Left|panel-left/i);
    await configPage.confirmDialog();
    await expect(adminPage.getByText(/更新成功|Updated successfully|success/i).first()).toBeVisible({
      timeout: 5000,
    });

    // Restore default right layout.
    await configPage.openEditByKey('sys.auth.loginPanelLayout');
    await configPage.selectDialogOption('参数键值', /右侧|Right|panel-right/i);
    await configPage.confirmDialog();
    await expect(adminPage.getByText(/更新成功|Updated successfully|success/i).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('TC-7c: 自定义 select 参数创建后编辑可从 options 选择', async ({
    adminPage,
  }) => {
    const configPage = new ConfigPage(adminPage);
    await configPage.goto();

    const optionsText = '选项甲=opt-a\n选项乙=opt-b';
    await configPage.createSelect(
      selectName,
      selectKey,
      optionsText,
      '选项甲',
      'typed select e2e',
    );
    await expect(adminPage.getByText(/创建成功|Created successfully|success/i).first()).toBeVisible({
      timeout: 5000,
    });

    await configPage.openEditByKey(selectKey);
    await configPage.selectDialogOption('参数键值', /选项乙|opt-b/i);
    await configPage.confirmDialog();
    await expect(adminPage.getByText(/更新成功|Updated successfully|success/i).first()).toBeVisible({
      timeout: 5000,
    });

    await configPage.delete(selectName);
  });

  test('TC-7d: 富文本类型使用宽弹窗、可全屏与更高编辑区', async ({
    adminPage,
  }) => {
    const configPage = new ConfigPage(adminPage);
    await configPage.goto();
    await configPage.openCreateDialog();

    const dialog = configPage.createEditDialog;
    const compactBox = await dialog.boundingBox();
    expect(compactBox).toBeTruthy();
    const compactWidth = compactBox!.width;
    await expect(configPage.dialogFullscreenButton).toHaveCount(0);

    await configPage.selectValueType(/富文本|Rich Text/i);
    await expect(
      dialog.getByTestId('config-modal-value-type-richtext'),
    ).toBeVisible();
    await expect(configPage.richtextEditor).toBeVisible();

    const spaciousBox = await dialog.boundingBox();
    expect(spaciousBox).toBeTruthy();
    // Spacious policy targets ~960px (capped by viewport); must exceed default 520px form.
    expect(spaciousBox!.width).toBeGreaterThan(compactWidth + 80);
    expect(spaciousBox!.width).toBeGreaterThan(600);

    const editorContent = configPage.richtextEditorContent;
    await expect(editorContent).toBeVisible();
    const editorBox = await editorContent.boundingBox();
    expect(editorBox).toBeTruthy();
    // clamp floor is 360px; allow minor chrome/padding variance.
    expect(editorBox!.height).toBeGreaterThanOrEqual(340);

    // Fullscreen entry is part of the spacious long-term layout contract.
    await expect(configPage.dialogFullscreenButton).toBeVisible();

    // Switching back to a compact type restores the default dialog density.
    await configPage.selectValueType(/单行文本|^Text$/i);
    await expect(
      dialog.getByTestId('config-modal-value-type-text'),
    ).toBeVisible({ timeout: 5000 });
    await expect(configPage.richtextEditor).toHaveCount(0);
    await expect(configPage.dialogFullscreenButton).toHaveCount(0);

    const restoredBox = await dialog.boundingBox();
    expect(restoredBox).toBeTruthy();
    expect(Math.abs(restoredBox!.width - compactWidth)).toBeLessThan(40);

    await adminPage.keyboard.press('Escape');
  });

  test('TC-7e: JSON 类型使用代码编辑器、校验格式并可格式化保存', async ({
    adminPage,
  }) => {
    const jsonName = `类型化JSON_${Date.now()}`;
    const jsonKey = `test.typed.json.${Date.now()}`;
    const configPage = new ConfigPage(adminPage);
    await configPage.goto();
    await configPage.openCreateDialog();

    const dialog = configPage.createEditDialog;
    const compactBox = await dialog.boundingBox();
    expect(compactBox).toBeTruthy();

    await configPage.fillDialogField('参数名称', jsonName);
    await configPage.fillDialogField('参数键名', jsonKey);
    await configPage.selectValueType(/^JSON$/);
    await expect(dialog.getByTestId('config-modal-value-type-json')).toBeVisible();
    await expect(configPage.jsonEditor).toBeVisible();

    // spacious 档：弹窗加宽、提供全屏入口、编辑区不低于 clamp 下限
    const spaciousBox = await dialog.boundingBox();
    expect(spaciousBox!.width).toBeGreaterThan(compactBox!.width + 80);
    await expect(configPage.dialogFullscreenButton).toBeVisible();
    const editorBox = await configPage.jsonEditor.boundingBox();
    expect(editorBox!.height).toBeGreaterThanOrEqual(340);

    // 非法 JSON：确定被拦截，值字段下出现格式错误提示
    await configPage.fillJsonEditor('{"a":1,');
    await configPage.clickDialogConfirm();
    const jsonError = configPage.dialogFieldError('参数键值');
    // 只断言文字存在会漏掉“提示被弹窗滚动区裁掉、用户看不见”的情况，必须断言可见且在视口内
    await expect(jsonError).toContainText('JSON 格式不正确');
    await expect(jsonError).toBeVisible();
    await expect(jsonError).toBeInViewport();
    await expect(dialog).toBeVisible();

    // 合法 JSON：格式化为两空格缩进后保存
    await configPage.fillJsonEditor('{"b":1,"a":[1,2]}');
    await configPage.jsonFormatButton.click();
    await expect(configPage.jsonEditorContent).toContainText('"b": 1,');
    await configPage.confirmDialog();
    await expect(
      adminPage.getByText(/创建成功|Created successfully|success/i).first(),
    ).toBeVisible({ timeout: 5000 });

    // 重新打开编辑：入库是紧凑文本，编辑器打开时格式化展示
    await configPage.openEditByKey(jsonKey);
    await expect(configPage.jsonEditor).toBeVisible();
    await expect(configPage.jsonEditorContent).toContainText('"b": 1,');
    await expect(configPage.jsonEditorContent).toContainText('"a": [');
    // 列表里存的应是紧凑文本，不应带缩进换行
    const storedValue = await configPage.getRowCellTextByKey(
      jsonKey,
      '参数键值',
    );
    expect(storedValue).toBe('{"b":1,"a":[1,2]}');
    await adminPage.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

    await configPage.delete(jsonName);
  });
});
