package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	_ "github.com/gogf/gf/contrib/drivers/pgsql/v2"
	"github.com/gogf/gf/v2/database/gdb"
)

// 员工表名与在职状态取值，来源：linapro-employee-core 的
// internal/dao/internal/employee.go 与 cap/empcap/empcap.go（StatusActive = 1）。
const (
	employeeTable  = "plugin_linapro_employee_core_employee"
	statusActive   = 1
	statusDeparted = 0
)

// employee 是签发 token 所需的员工信息。
type employee struct {
	ID         int64  `orm:"id"`
	TenantID   int    `orm:"tenant_id"`
	Name       string `orm:"name"`
	EmployeeNo string `orm:"moka_employee_no"`
	Status     int    `orm:"status"`
}

// lookupEmployee 按工号查找存活（未软删）的员工，并要求唯一命中且在职。
// tenantID >= 0 时额外按租户过滤，用于同一工号在多个租户各有一行的情况。
func lookupEmployee(ctx context.Context, link, empNo string, tenantID int) (employee, error) {
	empNo = strings.TrimSpace(empNo)
	if link == "" {
		return employee{}, errors.New("本地配置缺少 " + dbLinkConfigKey)
	}
	db, err := gdb.New(gdb.ConfigNode{Link: link})
	if err != nil {
		return employee{}, fmt.Errorf("连接数据库失败: %w", err)
	}
	defer db.Close(ctx)

	model := db.Model(employeeTable).Ctx(ctx).
		Fields("id", "tenant_id", "name", "moka_employee_no", "status").
		Where("moka_employee_no", empNo).
		WhereNull("deleted_at").
		OrderAsc("tenant_id")
	if tenantID >= 0 {
		model = model.Where("tenant_id", tenantID)
	}
	var rows []employee
	if err := model.Scan(&rows); err != nil {
		return employee{}, fmt.Errorf("查询员工表 %s 失败（员工插件未安装时该表不存在）: %w", employeeTable, err)
	}
	return pickEmployee(rows, empNo, tenantID)
}

// pickEmployee 从查询结果中选出唯一员工，并做存在性与在职校验。
func pickEmployee(rows []employee, empNo string, tenantID int) (employee, error) {
	switch len(rows) {
	case 0:
		if tenantID >= 0 {
			return employee{}, fmt.Errorf("租户 %d 下不存在工号为 %s 的员工", tenantID, empNo)
		}
		return employee{}, fmt.Errorf("不存在工号为 %s 的员工", empNo)
	case 1:
	default:
		tenants := make([]string, 0, len(rows))
		for _, r := range rows {
			tenants = append(tenants, fmt.Sprintf("%d(empId=%d)", r.TenantID, r.ID))
		}
		return employee{}, fmt.Errorf("工号 %s 命中多个租户 %s，请用 -tenant-id 指定", empNo, strings.Join(tenants, ", "))
	}
	emp := rows[0]
	if emp.Status != statusActive {
		return employee{}, fmt.Errorf("员工 %s（%s, empId=%d）已离职（status=%d），EmpAuth 会拒绝其 token", emp.Name, empNo, emp.ID, emp.Status)
	}
	return emp, nil
}
