package authtest

import "example.com/exporter/company/ext"

func init() {
	ext.RegisterCapability(ext.CapabilityInfo{
		Name:           "authtest",
		Kind:           ext.CapabilitySecurity,
		Version:        "1.0.0",
		Description:    "Require the testauth request header before exposing metrics.",
		Owner:          "security",
		ImportPath:     "example.com/exporter/custom/capabilities/authtest",
		Source:         "custom/capabilities/authtest",
		DefaultEnabled: false,
		Provides:       []string{"security:testauth"},
		Requires:       []string{},
		Compatible:     ext.CompatibleRange{Exporters: []string{"*"}},
		Files:          []string{"custom/capabilities/authtest/capability.go"},
	})
}
