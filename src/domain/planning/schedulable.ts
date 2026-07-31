export function isSchedulableTaskStatus(status: string): boolean {
  return status !== 'WAITING' && status !== 'DONE' && status !== 'CANCELLED';
}
