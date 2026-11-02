package main

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// empClaims 与 empcap/empcap_token.go 中的 empClaims 字段与 json tag 完全一致；
// empcap 的类型未导出，这里按同一结构复刻，修改时须两边同步。
type empClaims struct {
	EmpID    int64 `json:"empId"`
	TenantID int   `json:"tenantId"`
	jwt.RegisteredClaims
}

// signEmpToken 以 HS256 和员工 JWT 专用密钥签发 token，载荷与 empcap.IssueToken 一致，
// 仅有效期由调用方指定。
func signEmpToken(secret string, empID int64, tenantID int, now time.Time, ttl time.Duration) (string, error) {
	claims := empClaims{
		EmpID:    empID,
		TenantID: tenantID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
}
