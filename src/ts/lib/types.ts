export type AppointmentStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled' | 'completed';
export type PaymentStatus = 'not_required' | 'unpaid' | 'paid' | 'refunded';

export interface Service {
  id: string;
  name: string;
  description: string | null;
  price_pln: number;
  duration_min: number | null;
  requires_slot: boolean;
  sort: number;
}

export interface Slot {
  id: string;
  starts_at: string;
  ends_at: string;
}

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
}

export interface QuestionnaireRow {
  appointment_id: string;
  user_id: string;
  answers: Record<string, unknown>;
  current_step: number;
  health_consent_at: string | null;
  submitted_at: string | null;
  updated_at: string;
}

export interface Appointment {
  id: string;
  user_id: string;
  service_id: string;
  slot_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  mode: 'online' | 'telefon';
  client_note: string | null;
  status: AppointmentStatus;
  admin_message: string | null;
  cancelled_by: 'client' | 'admin' | null;
  price_pln: number;
  payment_status: PaymentStatus;
  created_at: string;
}

/** PostgREST embeds a one-to-one relation as an object, but be defensive about arrays. */
export function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
