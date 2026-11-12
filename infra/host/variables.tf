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

variable "root_gb" {
  description = "Operating system, Docker images and the runner itself. Rebuildable."
  type        = number
  default     = 30
}

variable "data_gb" {
  description = "Everything Loom writes: checkouts, user homes, database, logs. The only copy."
  type        = number
  default     = 50
}
