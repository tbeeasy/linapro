// This file covers value-type validation, built-in type locking, and multi_select
// serialization for the sysconfig management service.

package sysconfig

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"lina-core/internal/dao"
	"lina-core/internal/model/do"
	"lina-core/internal/model/entity"
	"lina-core/pkg/bizerr"
	"lina-core/pkg/configvaluetype"
)

// TestCreateSelectConfigPersistsTypeAndOptions verifies select metadata is stored.
func TestCreateSelectConfigPersistsTypeAndOptions(t *testing.T) {
	ctx := context.Background()
	key := fmt.Sprintf("test.select.%d", time.Now().UnixNano())
	id, err := New(nil, nil).Create(ctx, CreateInput{
		Name:      "Select test",
		Key:       key,
		Value:     "a",
		ValueType: configvaluetype.Select.String(),
		Options: []configvaluetype.Option{
			{Label: "A", Value: "a"},
			{Label: "B", Value: "b"},
		},
	})
	if err != nil {
		t.Fatalf("create select config: %v", err)
	}
	t.Cleanup(func() {
		_, _ = dao.SysConfig.Ctx(ctx).Unscoped().Where(do.SysConfig{Id: id}).Delete()
	})

	var row *entity.SysConfig
	if err = dao.SysConfig.Ctx(ctx).Where(do.SysConfig{Id: id}).Scan(&row); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if row.ValueType != configvaluetype.Select.String() {
		t.Fatalf("expected select type, got %q", row.ValueType)
	}
	if row.Value != "a" {
		t.Fatalf("expected value a, got %q", row.Value)
	}
	if row.Options == "" {
		t.Fatal("expected options to be persisted")
	}
}

// TestCreateRejectsInvalidSelectValue verifies enum values must exist in options.
func TestCreateRejectsInvalidSelectValue(t *testing.T) {
	ctx := context.Background()
	key := fmt.Sprintf("test.select.bad.%d", time.Now().UnixNano())
	_, err := New(nil, nil).Create(ctx, CreateInput{
		Name:      "Select bad",
		Key:       key,
		Value:     "c",
		ValueType: configvaluetype.Select.String(),
		Options: []configvaluetype.Option{
			{Label: "A", Value: "a"},
		},
	})
	if !bizerr.Is(err, CodeSysConfigTypedValueInvalid) {
		t.Fatalf("expected typed value invalid, got %v", err)
	}
}

// TestCreateBooleanRejectsNonTrueFalse verifies boolean type validation.
func TestCreateBooleanRejectsNonTrueFalse(t *testing.T) {
	ctx := context.Background()
	key := fmt.Sprintf("test.bool.bad.%d", time.Now().UnixNano())
	_, err := New(nil, nil).Create(ctx, CreateInput{
		Name:      "Bool bad",
		Key:       key,
		Value:     "yes",
		ValueType: configvaluetype.Boolean.String(),
	})
	if !bizerr.Is(err, CodeSysConfigTypedValueInvalid) {
		t.Fatalf("expected typed value invalid, got %v", err)
	}
}

// TestCreateJSONRejectsInvalidJSON 验证 json 类型的非法值映射为类型值错误码。
func TestCreateJSONRejectsInvalidJSON(t *testing.T) {
	ctx := context.Background()
	key := fmt.Sprintf("test.json.bad.%d", time.Now().UnixNano())
	_, err := New(nil, nil).Create(ctx, CreateInput{
		Name:      "JSON bad",
		Key:       key,
		Value:     `{"a":1,}`,
		ValueType: configvaluetype.JSON.String(),
	})
	if !bizerr.Is(err, CodeSysConfigTypedValueInvalid) {
		t.Fatalf("expected typed value invalid, got %v", err)
	}
}

// TestCreateJSONPersistsCompact 验证 json 值入库前去掉空白，但内容、键序与数字精度不变。
func TestCreateJSONPersistsCompact(t *testing.T) {
	ctx := context.Background()
	key := fmt.Sprintf("test.json.%d", time.Now().UnixNano())
	// 含缩进、换行、键序非字典序，以及超过 float64 精度的大整数
	value := "{\n  \"b\": 12345678901234567890,\n  \"a\": [1, 2],\n  \"s\": \"含 空格 与 \\\"引号\\\"\"\n}"
	id, err := New(nil, nil).Create(ctx, CreateInput{
		Name:      "JSON test",
		Key:       key,
		Value:     value,
		ValueType: configvaluetype.JSON.String(),
	})
	if err != nil {
		t.Fatalf("create json config: %v", err)
	}
	t.Cleanup(func() {
		_, _ = dao.SysConfig.Ctx(ctx).Unscoped().Where(do.SysConfig{Id: id}).Delete()
	})

	var row *entity.SysConfig
	if err = dao.SysConfig.Ctx(ctx).Where(do.SysConfig{Id: id}).Scan(&row); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if row.ValueType != configvaluetype.JSON.String() {
		t.Fatalf("expected json type, got %q", row.ValueType)
	}
	want := `{"b":12345678901234567890,"a":[1,2],"s":"含 空格 与 \"引号\""}`
	if row.Value != want {
		t.Fatalf("expected compact value %q, got %q", want, row.Value)
	}
}

// TestCompactJSONValue 验证压缩只删空白，非法 JSON 原样返回。
func TestCompactJSONValue(t *testing.T) {
	cases := map[string]string{
		"{\n\t\"a\": 1\n}": `{"a":1}`,
		"  [1, 2]  ":       `[1,2]`,
		`"a  b"`:           `"a  b"`,
		"{bad}":            "{bad}",
		"   ":              "",
	}
	for input, want := range cases {
		if got := compactJSONValue(input); got != want {
			t.Fatalf("compact %q: expected %q, got %q", input, want, got)
		}
	}
}

// TestUpdateBuiltinRejectsTypeChange verifies built-in type/options stay locked.
func TestUpdateBuiltinRejectsTypeChange(t *testing.T) {
	ctx := context.Background()
	record := insertConfigForBuiltInGuard(t, ctx, true)
	// Ensure known type metadata.
	_, err := dao.SysConfig.Ctx(ctx).Where(do.SysConfig{Id: record.Id}).Data(do.SysConfig{
		ValueType: configvaluetype.Text.String(),
		Options:   "",
		Value:     "seed",
	}).Update()
	if err != nil {
		t.Fatalf("seed type: %v", err)
	}

	newType := configvaluetype.Boolean.String()
	err = New(nil, nil).Update(ctx, UpdateInput{
		Id:        record.Id,
		ValueType: &newType,
	})
	if !bizerr.Is(err, CodeSysConfigBuiltinTypeChangeDenied) {
		t.Fatalf("expected builtin type change denied, got %v", err)
	}
}

// TestCreateMultiSelectNormalizesSeparator verifies multi_select serialization.
func TestCreateMultiSelectNormalizesSeparator(t *testing.T) {
	ctx := context.Background()
	key := fmt.Sprintf("test.multi.%d", time.Now().UnixNano())
	id, err := New(nil, nil).Create(ctx, CreateInput{
		Name:      "Multi test",
		Key:       key,
		Value:     " a ; b ; a ",
		ValueType: configvaluetype.MultiSelect.String(),
		Options: []configvaluetype.Option{
			{Label: "A", Value: "a"},
			{Label: "B", Value: "b"},
		},
	})
	if err != nil {
		t.Fatalf("create multi_select: %v", err)
	}
	t.Cleanup(func() {
		_, _ = dao.SysConfig.Ctx(ctx).Unscoped().Where(do.SysConfig{Id: id}).Delete()
	})

	var row *entity.SysConfig
	if err = dao.SysConfig.Ctx(ctx).Where(do.SysConfig{Id: id}).Scan(&row); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if row.Value != "a;b" {
		t.Fatalf("expected a;b, got %q", row.Value)
	}
}

// TestImportDefaultsMissingValueTypeToText verifies empty type column defaults to text.
func TestImportDefaultsMissingValueTypeToText(t *testing.T) {
	ctx := context.Background()
	key := fmt.Sprintf("test.import.defaulttype.%d", time.Now().UnixNano())
	importData := buildConfigImportFile(t, []string{
		"Import default type",
		key,
		"hello",
		"",
		"",
		"remark",
	})
	result, err := New(nil, nil).Import(ctx, bytes.NewReader(importData), false)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if result.Success != 1 {
		t.Fatalf("expected success, got %#v", result)
	}
	t.Cleanup(func() {
		_, _ = dao.SysConfig.Ctx(ctx).Unscoped().Where(do.SysConfig{Key: key}).Delete()
	})
	var row *entity.SysConfig
	if err = dao.SysConfig.Ctx(ctx).Where(do.SysConfig{Key: key}).Scan(&row); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if row.ValueType != configvaluetype.Text.String() {
		t.Fatalf("expected text default, got %q", row.ValueType)
	}
}
