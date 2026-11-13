variable "profile" {
  description = "AWS CLI profile of the project the host lives in."
  type        = string
  default     = "loom"
}

variable "region" {
  description = "The project's one Region."
  type        = string
  default     = "eu-north-1"
}

variable "hostname" {
  description = "DNS name people reach the runner at. Its A record must point at the host's address."
  type        = string
}

variable "instance_type" {
  description = "Must be x86_64, so a change of size never needs a rebuilt host."
  type        = string
  default     = "m7i-flex.large"
}

variable "enable_kata_workspaces" {
  description = "Opt in to Kata workspace VMs and nested virtualization. Activation may stop the host."
  type        = bool
  default     = false
}

variable "root_gb" {
  description = "Operating system, Docker images and the runner itself. Rebuildable."
  type        = number
  default     = 30
}

variable "data_gb" {
  description = "Everything Loom writes: checkouts, user homes, database, logs. Backed up daily."
  type        = number
  default     = 50
}

variable "snapshot_time_utc" {
  description = "Daily snapshot time, in UTC."
  type        = string
  default     = "02:00"
  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]$", var.snapshot_time_utc))
    error_message = "Use a UTC time in HH:MM format."
  }
}

variable "snapshot_retention" {
  description = "Number of daily data-disk snapshots to retain."
  type        = number
  default     = 7
  validation {
    condition     = var.snapshot_retention >= 1 && var.snapshot_retention <= 365 && floor(var.snapshot_retention) == var.snapshot_retention
    error_message = "Retain between 1 and 365 daily snapshots."
  }
}
