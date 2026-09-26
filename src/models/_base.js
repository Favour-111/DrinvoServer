import mongoose from 'mongoose';

export const { Schema } = mongoose;
export const ObjectId = Schema.Types.ObjectId;

/** Shared schema options: timestamps, `id` string, virtuals in JSON, no __v. */
export function baseOptions(extra = {}) {
  return {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret.password;
        return ret;
      },
    },
    toObject: { virtuals: true },
    ...extra,
  };
}

export const money = { type: Number, default: 0, min: 0 };
export const ref = (model, required = false) => ({ type: ObjectId, ref: model, required, index: true });
