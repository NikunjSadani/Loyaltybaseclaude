terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # GCS backend — stores Terraform state in gifsy-platform GCS bucket.
  # This bucket must be created ONCE before `terraform init` (see README.md).
  backend "gcs" {
    bucket = "gifsy-terraform-state"
    prefix = "terraform/state"
  }
}
