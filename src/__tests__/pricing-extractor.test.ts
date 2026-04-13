import { describe, expect, it } from "vitest";
import type { PricingResource } from "../core/pricing-types.js";
import { extractPricingResources } from "../pricing-extractor.js";

function makePlan(resourceChanges: unknown[]) {
  return { resource_changes: resourceChanges };
}

describe("extractPricingResources", () => {
  it("extracts AWS VM resources into vm_compute dimensions", () => {
    const plan = makePlan([
      {
        address: "aws_instance.web",
        type: "aws_instance",
        change: {
          actions: ["update"],
          before: {
            instance_type: "t3.micro",
            availability_zone: "us-east-1a",
          },
          after: {
            instance_type: "t3.small",
            availability_zone: "us-east-1a",
          },
        },
      },
    ]);

    const result = extractPricingResources(plan);
    expect(result).toEqual([
      {
        address: "aws_instance.web",
        type: "aws_instance",
        action: "update",
        provider: "aws",
        region: "us-east-1",
        pricingFamily: "vm_compute",
        before: { sku: "t3.micro" },
        after: { sku: "t3.small" },
      } satisfies Partial<PricingResource>,
    ]);
  });

  it("extracts Azure VM resources with OS discriminator inside dimensions", () => {
    const plan = makePlan([
      {
        address: "azurerm_windows_virtual_machine.web",
        type: "azurerm_windows_virtual_machine",
        change: {
          actions: ["delete"],
          before: {
            size: "Standard_D2s_v3",
            location: "westeurope",
          },
        },
      },
    ]);

    const result = extractPricingResources(plan);
    expect(result[0]).toEqual({
      address: "azurerm_windows_virtual_machine.web",
      type: "azurerm_windows_virtual_machine",
      action: "delete",
      provider: "azure",
      region: "westeurope",
      pricingFamily: "vm_compute",
      before: {
        sku: "Standard_D2s_v3",
        osDiscriminator: "windows",
      },
      after: null,
    } satisfies Partial<PricingResource>);
  });

  it("extracts AWS RDS resources into managed_db dimensions", () => {
    const plan = makePlan([
      {
        address: "aws_db_instance.main",
        type: "aws_db_instance",
        change: {
          actions: ["create"],
          after: {
            instance_class: "db.t3.micro",
            engine: "postgres",
            allocated_storage: 20,
            storage_type: "gp3",
            iops: 3000,
            storage_throughput: 125,
            multi_az: true,
            availability_zone: "us-east-1a",
          },
        },
      },
    ]);

    const result = extractPricingResources(plan);
    expect(result[0]).toEqual({
      address: "aws_db_instance.main",
      type: "aws_db_instance",
      action: "create",
      provider: "aws",
      region: "us-east-1",
      pricingFamily: "managed_db",
      before: null,
      after: {
        engine: "postgres",
        sku: "db.t3.micro",
        deploymentModel: "multi_az",
        highAvailability: true,
        storage: {
          sizeGiB: 20,
          storageClass: "gp3",
          iops: 3000,
          throughputMbps: 125,
        },
      },
    } satisfies Partial<PricingResource>);
  });

  it("extracts GCP Cloud SQL resources into managed_db dimensions", () => {
    const plan = makePlan([
      {
        address: "google_sql_database_instance.main",
        type: "google_sql_database_instance",
        change: {
          actions: ["update"],
          before: {
            region: "us-central1",
            database_version: "POSTGRES_14",
            settings: [
              {
                tier: "db-g1-small",
                availability_type: "ZONAL",
                disk_size: 20,
                disk_type: "PD_HDD",
              },
            ],
          },
          after: {
            region: "us-central1",
            database_version: "POSTGRES_14",
            settings: [
              {
                tier: "db-g1-small",
                availability_type: "REGIONAL",
                disk_size: 100,
                disk_type: "PD_SSD",
              },
            ],
          },
        },
      },
    ]);

    const result = extractPricingResources(plan);
    expect(result[0]).toMatchObject({
      pricingFamily: "managed_db",
      before: {
        engine: "postgres",
        sku: "db-g1-small",
        deploymentModel: "zonal",
        highAvailability: false,
        storage: {
          sizeGiB: 20,
          storageClass: "pd_hdd",
        },
      },
      after: {
        engine: "postgres",
        sku: "db-g1-small",
        deploymentModel: "regional",
        highAvailability: true,
        storage: {
          sizeGiB: 100,
          storageClass: "pd_ssd",
        },
      },
    } satisfies Partial<PricingResource>);
  });

  it("extracts cache resources across providers", () => {
    const plan = makePlan([
      {
        address: "aws_elasticache_cluster.cache",
        type: "aws_elasticache_cluster",
        change: {
          actions: ["create"],
          after: {
            engine: "redis",
            node_type: "cache.t3.micro",
            num_cache_nodes: 2,
            availability_zone: "us-east-1a",
          },
        },
      },
      {
        address: "google_redis_instance.cache",
        type: "google_redis_instance",
        change: {
          actions: ["create"],
          after: {
            region: "us-central1",
            tier: "STANDARD_HA",
            memory_size_gb: 5,
            replica_count: 1,
          },
        },
      },
      {
        address: "azurerm_redis_cache.cache",
        type: "azurerm_redis_cache",
        change: {
          actions: ["create"],
          after: {
            location: "eastus",
            sku_name: "Standard",
            family: "C",
            capacity: 1,
          },
        },
      },
    ]);

    const result = extractPricingResources(plan);
    expect(result).toHaveLength(3);
    expect(result[0].pricingFamily).toBe("cache");
    expect(result[0].after).toEqual({
      engine: "redis",
      sku: "cache.t3.micro",
      highAvailability: true,
      replicaCount: 1,
    });
    expect(result[1].after).toEqual({
      engine: "redis",
      sku: "5gib",
      tier: "standard_ha",
      highAvailability: true,
      replicaCount: 1,
    });
    expect(result[2].after).toEqual({
      engine: "redis",
      sku: "Standard:C:1",
      tier: "standard",
      highAvailability: true,
      replicaCount: 1,
    });
  });

  it("extracts block storage resources across providers", () => {
    const plan = makePlan([
      {
        address: "aws_ebs_volume.data",
        type: "aws_ebs_volume",
        change: {
          actions: ["create"],
          after: {
            type: "gp3",
            size: 100,
            iops: 3000,
            throughput: 125,
            availability_zone: "us-east-1a",
          },
        },
      },
      {
        address: "google_compute_disk.data",
        type: "google_compute_disk",
        change: {
          actions: ["create"],
          after: {
            type: "projects/p/zones/us-central1-a/diskTypes/pd-balanced",
            size: 100,
            provisioned_iops: 5000,
            provisioned_throughput: 240,
            zone: "us-central1-a",
          },
        },
      },
      {
        address: "azurerm_managed_disk.data",
        type: "azurerm_managed_disk",
        change: {
          actions: ["create"],
          after: {
            storage_account_type: "UltraSSD_LRS",
            disk_size_gb: 512,
            disk_iops_read_write: 2000,
            disk_mbps_read_write: 120,
            location: "eastus",
          },
        },
      },
    ]);

    const result = extractPricingResources(plan);
    expect(result).toHaveLength(3);
    expect(result[0].pricingFamily).toBe("block_storage");
    expect(result[1].after).toEqual({
      sku: "pd-balanced",
      sizeGiB: 100,
      iops: 5000,
      throughputMbps: 240,
    });
    expect(result[2].after).toEqual({
      sku: "UltraSSD_LRS",
      sizeGiB: 512,
      iops: 2000,
      throughputMbps: 120,
    });
  });

  it("marks supported resources as unpriced when required dimensions are missing", () => {
    const plan = makePlan([
      {
        address: "aws_db_instance.main",
        type: "aws_db_instance",
        change: {
          actions: ["create"],
          after: {
            engine: "postgres",
          },
        },
      },
    ]);

    const result = extractPricingResources(plan);
    expect(result[0].unpricedReason).toBe("missing_dimensions");
    expect(result[0].region).toBe("");
  });

  it("skips unsupported resource types", () => {
    const plan = makePlan([
      {
        address: "aws_s3_bucket.data",
        type: "aws_s3_bucket",
        change: {
          actions: ["create"],
          after: { bucket: "data" },
        },
      },
    ]);

    const result = extractPricingResources(plan);
    expect(result).toEqual([]);
  });
});
