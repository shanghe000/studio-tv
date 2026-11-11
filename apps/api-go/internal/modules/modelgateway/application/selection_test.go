package application

import "testing"

func TestCatalogDefaultPrefersLatestPublicVersionWithoutProviderNames(t *testing.T) {
	current := Capability{}
	for _, v := range []string{"5.6", "6", "6.1"} {
		c := Capability{Ref: v, Available: true, Model: &ModelDescriptor{ProviderRef: "supplier", Version: v}}
		if PreferCapability(c, current) {
			current = c
		}
	}
	if current.Ref != "6.1" {
		t.Fatal("default changed legacy latest-version behavior")
	}
	other := Capability{Available: true, Model: &ModelDescriptor{ProviderRef: "other", Version: "99"}}
	if PreferCapability(other, current) {
		t.Fatal("cross-supplier order inferred from incomparable versions")
	}
	if PreferCapability(Capability{Available: true, TestMode: true}, current) || PreferCapability(Capability{Available: false, Model: &ModelDescriptor{ProviderRef: "supplier", Version: "99"}}, current) {
		t.Fatal("fixture/unconfigured displaced real model")
	}
}
